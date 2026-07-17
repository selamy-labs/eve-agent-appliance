#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { canonicalJson } from "./canonical-json.mjs";

export const SCHEMA_VERSION = "agents.selamy.ai/v1alpha1";
export const EXEC_OUTPUT_BYTE_CAP = 65_536;

const LOGICAL_NAME = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const CORRELATION_ATTRIBUTE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const DNS_LABEL = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const RESOURCE_QUANTITY = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:m|[kKMGTPE]i?|[eE][+-]?[0-9]+)?$/;
const ENDPOINT = /^(?<host>[^:]+):(?<port>[1-9][0-9]{0,4})$/;

const MODES = new Set(["in_process", "exec", "sidecar", "job", "cronjob", "deployment"]);
const PROTOCOLS = new Set(["eve.tool.v1", "selamy.exec.v1", "grpc", "k8s.job.result.v1", "rest"]);
const OWNERS = new Set(["eve-process", "k8s-controller", "argo"]);
const APPROVALS = new Set(["internal-read-only", "scheduled-internal", "consequential-bounded", "authority-critical"]);
const HEALTH_KINDS = new Set(["none", "exec-exit", "grpc-health", "http-get"]);
const OTEL_MODES = new Set(["active-span-only", "exporter"]);
const CONSEQUENCES = new Set(["C0", "C1", "C2", "C3"]);
const HUMAN_FLOOR = {
  "internal-read-only": "C0",
  "scheduled-internal": "C1",
  "consequential-bounded": "C2",
  "authority-critical": "C3",
};

function fail(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

function objectAt(value, path, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!(key in value)) fail(`${path}.${key}`, "required field is missing");
  }
  return value;
}

function enumAt(value, path, members) {
  if (!members.has(value)) fail(path, `must be one of ${[...members].join(", ")}`);
  return value;
}

function logicalName(value, path) {
  if (typeof value !== "string" || !LOGICAL_NAME.test(value)) {
    fail(path, "must be a logical name");
  }
  return value;
}

function logicalList(value, path) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  const result = value.map((entry, index) => logicalName(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) fail(path, "must not contain duplicates");
  return result;
}

function correlationList(value, path) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !CORRELATION_ATTRIBUTE.test(entry)) {
      fail(`${path}[${index}]`, "must be an allowlisted telemetry attribute name");
    }
  }
  if (new Set(value).size !== value.length) fail(path, "must not contain duplicates");
  return value;
}

function positiveInteger(value, path, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(path, `must be an integer in 1..${maximum}`);
  }
  return value;
}

function quantity(value, path) {
  if (typeof value !== "string" || !RESOURCE_QUANTITY.test(value)) {
    fail(path, "must be a non-negative Kubernetes resource quantity string");
  }
  return value;
}

function validatePermissions(value, path) {
  objectAt(value, path, ["network", "secrets", "rbac"]);
  return {
    network: logicalList(value.network, `${path}.network`),
    secrets: logicalList(value.secrets, `${path}.secrets`),
    rbac: logicalList(value.rbac, `${path}.rbac`),
  };
}

function validateResources(value, path) {
  objectAt(value, path, ["timeoutSeconds", "memory", "cpu"], ["timeoutSeconds", "memory"]);
  const result = {
    timeoutSeconds: positiveInteger(value.timeoutSeconds, `${path}.timeoutSeconds`, 3600),
    memory: quantity(value.memory, `${path}.memory`),
  };
  if ("cpu" in value) result.cpu = quantity(value.cpu, `${path}.cpu`);
  return result;
}

function validateHealth(value, path) {
  if (value === undefined) return { kind: "none", requiredForReadiness: false };
  objectAt(value, path, ["kind", "requiredForReadiness"], []);
  const health = {
    kind: enumAt(value.kind ?? "none", `${path}.kind`, HEALTH_KINDS),
    requiredForReadiness: value.requiredForReadiness ?? false,
  };
  if (typeof health.requiredForReadiness !== "boolean") {
    fail(`${path}.requiredForReadiness`, "must be boolean");
  }
  if (health.requiredForReadiness && health.kind === "none") {
    fail(path, "readiness requires a non-none health kind");
  }
  return health;
}

function validateTelemetry(value, path, mode) {
  objectAt(value, path, ["otel", "correlation"]);
  const telemetry = {
    otel: enumAt(value.otel, `${path}.otel`, OTEL_MODES),
    correlation: correlationList(value.correlation, `${path}.correlation`),
  };
  if ((mode === "exec" || mode === "in_process") && telemetry.otel !== "active-span-only") {
    fail(`${path}.otel`, `${mode} requires active-span-only`);
  }
  return telemetry;
}

function validateIo(value, path) {
  objectAt(value, path, ["inputSchemaRef", "outputSchemaRef"]);
  for (const field of ["inputSchemaRef", "outputSchemaRef"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      fail(`${path}.${field}`, "must be a non-empty schema identifier");
    }
  }
  return value;
}

function validateModeFields(capability, path) {
  const has = (field) => Object.hasOwn(capability, field);
  const forbid = (...fields) => {
    for (const field of fields) if (has(field)) fail(`${path}.${field}`, `forbidden for mode ${capability.mode}`);
  };
  const requireField = (field) => {
    if (!has(field)) fail(`${path}.${field}`, `required for mode ${capability.mode}`);
  };

  if (capability.mode === "in_process") {
    if (capability.protocol !== "eve.tool.v1") fail(`${path}.protocol`, "in_process requires eve.tool.v1");
    requireField("io");
    forbid("binary", "endpoint", "schedule", "suspend", "replicas");
  } else if (capability.mode === "exec") {
    if (capability.protocol !== "selamy.exec.v1") fail(`${path}.protocol`, "exec requires selamy.exec.v1");
    requireField("binary");
    requireField("io");
    forbid("endpoint", "schedule", "suspend", "replicas");
  } else if (capability.mode === "sidecar") {
    if (capability.protocol !== "grpc") fail(`${path}.protocol`, "sidecar requires grpc");
    requireField("binary");
    requireField("endpoint");
    forbid("schedule", "suspend", "replicas", "io");
  } else if (capability.mode === "job") {
    if (capability.protocol !== "k8s.job.result.v1") fail(`${path}.protocol`, "job requires k8s.job.result.v1");
    requireField("binary");
    forbid("endpoint", "schedule", "suspend", "replicas", "io");
  } else if (capability.mode === "cronjob") {
    if (capability.protocol !== "k8s.job.result.v1") fail(`${path}.protocol`, "cronjob requires k8s.job.result.v1");
    requireField("binary");
    requireField("schedule");
    requireField("suspend");
    forbid("endpoint", "replicas", "io");
  } else if (capability.mode === "deployment") {
    if (capability.protocol !== "grpc" && capability.protocol !== "rest") {
      fail(`${path}.protocol`, "deployment requires grpc or rest");
    }
    requireField("binary");
    requireField("endpoint");
    forbid("schedule", "suspend", "io");
  }

  if (["sidecar", "job", "deployment"].includes(capability.mode) && capability.health.kind === "none") {
    fail(`${path}.health.kind`, `${capability.mode} requires a non-none health kind`);
  }
}

function validateCapability(raw, index) {
  const path = `spec.capabilities[${index}]`;
  objectAt(raw, path, [
    "name", "version", "mode", "protocol", "binary", "lifecycleOwner",
    "consequenceClass", "approvalClass", "permissions", "networkSurfaces",
    "resources", "health", "telemetry", "endpoint", "schedule", "suspend",
    "replicas", "io",
  ], [
    "name", "version", "mode", "protocol", "lifecycleOwner",
    "consequenceClass", "approvalClass", "permissions", "networkSurfaces",
    "resources", "telemetry",
  ]);
  const capability = {
    ...raw,
    name: logicalName(raw.name, `${path}.name`),
    version: positiveInteger(raw.version, `${path}.version`),
    mode: enumAt(raw.mode, `${path}.mode`, MODES),
    protocol: enumAt(raw.protocol, `${path}.protocol`, PROTOCOLS),
    lifecycleOwner: enumAt(raw.lifecycleOwner, `${path}.lifecycleOwner`, OWNERS),
    consequenceClass: enumAt(raw.consequenceClass, `${path}.consequenceClass`, CONSEQUENCES),
    approvalClass: enumAt(raw.approvalClass, `${path}.approvalClass`, APPROVALS),
    permissions: validatePermissions(raw.permissions, `${path}.permissions`),
    networkSurfaces: logicalList(raw.networkSurfaces, `${path}.networkSurfaces`),
    resources: validateResources(raw.resources, `${path}.resources`),
    health: validateHealth(raw.health, `${path}.health`),
  };
  capability.telemetry = validateTelemetry(raw.telemetry, `${path}.telemetry`, capability.mode);
  if ("binary" in raw) capability.binary = logicalName(raw.binary, `${path}.binary`);
  if ("io" in raw) capability.io = validateIo(raw.io, `${path}.io`);
  if ("replicas" in raw) capability.replicas = positiveInteger(raw.replicas, `${path}.replicas`);
  if ("suspend" in raw && typeof raw.suspend !== "boolean") fail(`${path}.suspend`, "must be boolean");
  if ("schedule" in raw && (typeof raw.schedule !== "string" || raw.schedule.trim().split(/\s+/).length !== 5)) {
    fail(`${path}.schedule`, "must be a five-field cron expression");
  }
  if ("endpoint" in raw) {
    const match = ENDPOINT.exec(raw.endpoint);
    if (!match || Number(match.groups.port) > 65_535) fail(`${path}.endpoint`, "must be host:port with port 1..65535");
    if (capability.mode === "sidecar") {
      const octets = match.groups.host.split(".").map(Number);
      if (octets.length !== 4 || octets[0] !== 127 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        fail(`${path}.endpoint`, "sidecar host must be within 127.0.0.0/8");
      }
    }
  }
  const floor = Number(HUMAN_FLOOR[capability.approvalClass].slice(1));
  if (Number(capability.consequenceClass.slice(1)) < floor) {
    fail(`${path}.consequenceClass`, `cannot be below approval floor ${HUMAN_FLOOR[capability.approvalClass]}`);
  }
  if ([...capability.permissions.network, ...capability.permissions.secrets, ...capability.permissions.rbac].length > 0 && capability.consequenceClass !== "C3") {
    fail(`${path}.consequenceClass`, "declared network, secret, or RBAC surfaces require C3");
  }
  validateModeFields(capability, path);
  return capability;
}

export function validateManifest(raw, bindings, expectedAgentName) {
  objectAt(raw, "$", ["apiVersion", "kind", "metadata", "spec"]);
  if (raw.apiVersion !== SCHEMA_VERSION) fail("apiVersion", `must equal ${SCHEMA_VERSION}`);
  if (raw.kind !== "EveAgentAppliance") fail("kind", "must equal EveAgentAppliance");
  objectAt(raw.metadata, "metadata", ["name"]);
  if (typeof raw.metadata.name !== "string" || !DNS_LABEL.test(raw.metadata.name)) {
    fail("metadata.name", "must be a DNS-1123 label");
  }
  if (raw.metadata.name !== expectedAgentName) {
    fail("metadata.name", `must equal consuming agent identity ${expectedAgentName}`);
  }
  objectAt(raw.spec, "spec", ["entrypoint", "capabilities"]);
  objectAt(raw.spec.entrypoint, "spec.entrypoint", ["capability", "port"]);
  const entrypoint = {
    capability: logicalName(raw.spec.entrypoint.capability, "spec.entrypoint.capability"),
    port: positiveInteger(raw.spec.entrypoint.port, "spec.entrypoint.port", 65_535),
  };
  if (!Array.isArray(raw.spec.capabilities) || raw.spec.capabilities.length === 0) {
    fail("spec.capabilities", "must be a non-empty array");
  }
  const capabilities = raw.spec.capabilities.map(validateCapability);
  const names = capabilities.map(({ name }) => name);
  if (new Set(names).size !== names.length) fail("spec.capabilities", "capability names must be unique");
  const entrypointCapability = capabilities.find(({ name }) => name === entrypoint.capability);
  if (!entrypointCapability || entrypointCapability.mode !== "in_process") {
    fail("spec.entrypoint.capability", "must reference exactly one in_process capability");
  }
  const ports = [entrypoint.port];
  for (const capability of capabilities) {
    if (capability.endpoint) ports.push(Number(ENDPOINT.exec(capability.endpoint).groups.port));
  }
  if (new Set(ports).size !== ports.length) fail("spec", "entrypoint and endpoint ports must be pairwise unique");
  const binaryNames = capabilities.filter(({ binary }) => binary).map(({ binary }) => binary);
  if (new Set(binaryNames).size !== binaryNames.length) fail("spec.capabilities", "binary logical names must be unique");
  const inProcessNames = capabilities
    .filter(({ mode }) => mode === "in_process")
    .map(({ name }) => name);
  const expectedBindings = [...binaryNames, ...inProcessNames].sort();
  const actualBindings = [...bindings.keys()].sort();
  if (canonicalJson(expectedBindings) !== canonicalJson(actualBindings)) {
    fail("bindings", `expected ${expectedBindings.join(", ")}; received ${actualBindings.join(", ")}`);
  }
  return {
    apiVersion: raw.apiVersion,
    kind: raw.kind,
    metadata: { name: raw.metadata.name },
    spec: { entrypoint, capabilities },
  };
}

function parseArguments(argv) {
  const scalar = new Map();
  const bindings = [];
  let pending = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail("arguments", `invalid argument at index ${index}`);
    if (flag === "--logical-name") {
      if (pending.logicalName) fail("arguments", "binding logical name repeated before completion");
      pending.logicalName = value;
    } else if (flag === "--binary") {
      pending.binary = value;
    } else if (flag === "--label") {
      pending.label = value;
      if (!pending.logicalName || !pending.binary) fail("arguments", "binding requires logical name, binary, then label");
      bindings.push(pending);
      pending = {};
    } else {
      if (scalar.has(flag)) fail("arguments", `duplicate ${flag}`);
      scalar.set(flag, value);
    }
  }
  if (Object.keys(pending).length > 0) fail("arguments", "incomplete binding");
  for (const flag of ["--agent-name", "--manifest", "--catalog", "--binding-manifest", "--canonical-manifest"]) {
    if (!scalar.has(flag)) fail("arguments", `missing ${flag}`);
  }
  return { scalar, bindings };
}

export function generateArtifacts(raw, bindingEntries, expectedAgentName = raw?.metadata?.name) {
  const bindings = new Map();
  for (const entry of bindingEntries) {
    logicalName(entry.logicalName, "binding.logicalName");
    if (bindings.has(entry.logicalName)) fail("bindings", `duplicate ${entry.logicalName}`);
    bindings.set(entry.logicalName, entry);
  }
  const manifest = validateManifest(raw, bindings, expectedAgentName);
  const canonicalManifest = canonicalJson(manifest);
  const manifestDigest = `sha256:${createHash("sha256").update(canonicalManifest).digest("hex")}`;
  const capabilities = manifest.spec.capabilities;
  const catalog = capabilities.map((capability) => ({
    id: `${manifest.metadata.name}.${capability.name}.v${capability.version}`,
    name: capability.name,
    version: capability.version,
    mode: capability.mode,
    protocol: capability.protocol,
    inputSchemaRef: capability.io?.inputSchemaRef ?? null,
    outputSchemaRef: capability.io?.outputSchemaRef ?? null,
    consequenceClass: capability.consequenceClass,
    approvalClass: capability.approvalClass,
    humanFloor: HUMAN_FLOOR[capability.approvalClass],
    requiredForReadiness: capability.health.requiredForReadiness,
    resources: { timeoutSeconds: capability.resources.timeoutSeconds },
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
  }));
  const bindingManifest = capabilities.map((capability) => {
    const logical = capability.binary ?? capability.name;
    const binding = bindings.get(logical);
    return {
      id: `${manifest.metadata.name}.${capability.name}.v${capability.version}`,
      logicalName: logical,
      label: binding.label,
      imagePath: `/opt/selamy/bin/${logical}`,
      protocol: capability.protocol,
      timeoutSeconds: capability.resources.timeoutSeconds,
      outputByteCap: EXEC_OUTPUT_BYTE_CAP,
      manifestDigest,
    };
  });
  return {
    canonicalManifest,
    catalog: canonicalJson(catalog),
    bindingManifest: canonicalJson(bindingManifest),
    manifestDigest,
  };
}

async function main() {
  const { scalar, bindings } = parseArguments(process.argv.slice(2));
  const source = await readFile(scalar.get("--manifest"), "utf8");
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) throw document.errors[0];
  const artifacts = generateArtifacts(
    document.toJS({ maxAliasCount: 0 }),
    bindings,
    scalar.get("--agent-name"),
  );
  await Promise.all([
    writeFile(scalar.get("--catalog"), artifacts.catalog, "utf8"),
    writeFile(scalar.get("--binding-manifest"), artifacts.bindingManifest, "utf8"),
    writeFile(scalar.get("--canonical-manifest"), artifacts.canonicalManifest, "utf8"),
  ]);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
