import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";
import { canonicalJson } from "../src/canonical-json.mjs";
import {
  EXEC_OUTPUT_BYTE_CAP,
  SCHEMA_VERSION,
  generateArtifacts,
  parseArguments,
  parseManifestYaml,
} from "../src/generate.mjs";

const fixtureUrl = new URL("fixtures/nova.yaml", import.meta.url);
const bindingEntries = [
  { logicalName: "eve", binary: "eve-runtime.txt", mode: "in_process", label: "//:eve_runtime" },
  {
    logicalName: "price-normalizer",
    binary: "price-normalizer.txt",
    mode: "exec",
    label: "//:price_normalizer",
  },
];

async function fixture() {
  return parse(await readFile(fixtureUrl, "utf8"));
}

function validateWithJsonSchema(schema, instances) {
  const validator = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
  }).compile(schema);
  return instances.map((instance) => validator(instance));
}

function modeShape(manifest, mode, protocol, fields = {}) {
  const capability = manifest.spec.capabilities[1];
  capability.mode = mode;
  capability.protocol = protocol;
  for (const field of ["endpoint", "schedule", "suspend", "replicas"]) delete capability[field];
  if (mode !== "exec") delete capability.io;
  Object.assign(capability, fields);
  return manifest;
}

test("generates deterministic canonical, catalog, and trusted binding artifacts", async () => {
  const first = generateArtifacts(await fixture(), bindingEntries);
  const second = generateArtifacts(await fixture(), [...bindingEntries].reverse());
  assert.deepEqual(first, second);
  assert.match(first.manifestDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.canonicalManifest.endsWith("\n"), false);

  const catalog = JSON.parse(first.catalog);
  assert.deepEqual(
    catalog.map(({ id }) => id),
    ["nova.eve.v1", "nova.price-normalizer.v1"],
  );
  assert.equal(catalog[1].schemaVersion, SCHEMA_VERSION);
  assert.equal(catalog[1].humanFloor, "C0");
  assert.equal(catalog[1].resources.timeoutSeconds, 5);
  for (const forbidden of ["label", "imagePath", "manifestDigest", "imageDigest", "secrets", "rbac"]) {
    assert.equal(first.catalog.includes(forbidden), false, `${forbidden} leaked into catalog`);
  }

  const binding = JSON.parse(first.bindingManifest);
  assert.equal(binding[1].imagePath, "/opt/selamy/bin/price-normalizer");
  assert.equal(binding[1].label, "//:price_normalizer");
  assert.equal(binding[1].outputByteCap, EXEC_OUTPUT_BYTE_CAP);
  assert.equal(binding[1].manifestDigest, first.manifestDigest);
  assert.equal(first.bindingManifest.includes("imageDigest"), false);
});

test("canonical JSON sorts recursively and rejects floating point values", () => {
  assert.equal(canonicalJson({ z: [3, { b: true, a: null }], a: "x" }), '{"a":"x","z":[3,{"a":null,"b":true}]}');
  assert.throws(() => canonicalJson({ value: 1.5 }), /safe integers only/);
});

test("fails closed on unknown fields and unknown enum members", async () => {
  const unknownField = await fixture();
  unknownField.spec.capabilities[1].command = "/bin/sh";
  assert.throws(() => generateArtifacts(unknownField, bindingEntries), /unknown field/);

  const unknownMode = await fixture();
  unknownMode.spec.capabilities[1].mode = "shell";
  assert.throws(() => generateArtifacts(unknownMode, bindingEntries), /must be one of/);

  const unknownVersion = await fixture();
  unknownVersion.apiVersion = "agents.selamy.ai/v2";
  assert.throws(() => generateArtifacts(unknownVersion, bindingEntries), /must equal agents\.selamy\.ai\/v1alpha1/);
});

test("rejects undeclared, unused, duplicate, and authority-shaped bindings", async () => {
  const missingBindingManifest = await fixture();
  assert.throws(
    () => generateArtifacts(missingBindingManifest, bindingEntries.slice(1)),
    /expected eve, price-normalizer; received price-normalizer/,
  );
  const duplicateBindingManifest = await fixture();
  assert.throws(
    () => generateArtifacts(duplicateBindingManifest, [...bindingEntries, bindingEntries[0]]),
    /duplicate eve/,
  );
  const authorityBindingManifest = await fixture();
  assert.throws(
    () => generateArtifacts(authorityBindingManifest, [{ ...bindingEntries[0], logicalName: "../eve" }]),
    /must be a logical name/,
  );
});

test("parses typed binding modes and rejects missing or mismatched modes", async () => {
  const scalarArguments = [
    "--agent-name", "nova",
    "--manifest", "appliance.yaml",
    "--catalog", "catalog.json",
    "--binding-manifest", "binding.json",
    "--canonical-manifest", "manifest.json",
  ];
  const parsed = parseArguments([
    ...scalarArguments,
    "--logical-name", "price-normalizer",
    "--binary", "price-normalizer",
    "--binding-mode", "exec",
    "--label", "//:price_normalizer",
  ]);
  assert.equal(parsed.bindings[0].mode, "exec");
  assert.throws(
    () => parseArguments([...scalarArguments, "--typo", "ignored"]),
    /unknown flag --typo/,
  );
  assert.throws(
    () => parseArguments([
      ...scalarArguments,
      "--logical-name", "price-normalizer",
      "--binary", "price-normalizer",
      "--label", "//:price_normalizer",
    ]),
    /binding requires logical name, binary, binding mode, then label/,
  );
  assert.throws(
    () => parseArguments([
      ...scalarArguments,
      "--logical-name", "price-normalizer",
      "--binding-mode", "exec",
      "--binary", "price-normalizer",
      "--label", "//:price_normalizer",
    ]),
    /binding mode requires logical name and binary and must appear once/,
  );

  const manifest = await fixture();
  const mismatched = bindingEntries.map((binding) => (
    binding.logicalName === "price-normalizer" ? { ...binding, mode: "in_process" } : binding
  ));
  assert.throws(
    () => generateArtifacts(manifest, mismatched),
    /bindings\.price-normalizer\.mode: must equal manifest capability mode exec/,
  );
  assert.throws(
    () => generateArtifacts(manifest, bindingEntries.map(({ mode: _mode, ...binding }) => binding)),
    /binding\.mode: required field is missing/,
  );
});

test("rejects every YAML parser diagnostic, including unknown tags", async () => {
  const source = await readFile(fixtureUrl, "utf8");
  assert.deepEqual(parseManifestYaml(source), await fixture());
  assert.throws(
    () => parseManifestYaml(source.replace("kind: EveAgentAppliance", "kind: !contract EveAgentAppliance")),
    /Unresolved tag: !contract/,
  );
  assert.throws(
    () => parseManifestYaml(`%YAML 1.3\n---\n${source}`),
    /Unsupported YAML version 1\.3/,
  );
  assert.throws(
    () => parseManifestYaml(`${source}\nkind: EveAgentAppliance\n`),
    /Map keys must be unique/,
  );
});

test("requires the entrypoint to be an in-process capability", async () => {
  const manifest = await fixture();
  manifest.spec.entrypoint.capability = "price-normalizer";
  assert.throws(
    () => generateArtifacts(manifest, bindingEntries),
    /must reference exactly one in_process capability/,
  );
});

test("binds the manifest identity to the consuming agent name", async () => {
  const manifest = await fixture();
  assert.throws(
    () => generateArtifacts(manifest, bindingEntries, "shepherd"),
    /must equal consuming agent identity shepherd/,
  );
});

test("requires every in-process capability to have its own Bazel binding", async () => {
  const manifest = await fixture();
  manifest.spec.capabilities.push({
    ...structuredClone(manifest.spec.capabilities[0]),
    name: "portfolio-view",
    health: { kind: "none", requiredForReadiness: false },
  });
  assert.throws(
    () => generateArtifacts(manifest, bindingEntries),
    /expected eve, portfolio-view, price-normalizer/,
  );
  const artifacts = generateArtifacts(manifest, [
    ...bindingEntries,
    { logicalName: "portfolio-view", binary: "portfolio.txt", mode: "in_process", label: "//:portfolio_view" },
  ]);
  assert.equal(JSON.parse(artifacts.catalog)[2].id, "nova.portfolio-view.v1");
});

test("accepts decimal Kubernetes quantity strings while rejecting numeric floats", async () => {
  const manifest = await fixture();
  manifest.spec.capabilities[1].resources.cpu = "0.5";
  manifest.spec.capabilities[1].resources.memory = "1.5Gi";
  assert.doesNotThrow(() => generateArtifacts(manifest, bindingEntries));
  manifest.spec.capabilities[1].resources.cpu = 0.5;
  assert.throws(() => generateArtifacts(manifest, bindingEntries), /quantity string/);
});

test("enforces mode, protocol, field, telemetry, health, and port rules", async () => {
  const wrongProtocol = await fixture();
  wrongProtocol.spec.capabilities[1].protocol = "grpc";
  assert.throws(() => generateArtifacts(wrongProtocol, bindingEntries), /exec requires selamy\.exec\.v1/);

  const shellSurface = await fixture();
  shellSurface.spec.capabilities[1].endpoint = "127.0.0.1:4000";
  assert.throws(() => generateArtifacts(shellSurface, bindingEntries), /forbidden for mode exec/);

  const exporter = await fixture();
  exporter.spec.capabilities[1].telemetry.otel = "exporter";
  assert.throws(() => generateArtifacts(exporter, bindingEntries), /exec requires active-span-only/);

  const unhealthy = await fixture();
  unhealthy.spec.capabilities[0].health.kind = "none";
  assert.throws(() => generateArtifacts(unhealthy, bindingEntries), /readiness requires a non-none health kind/);

  const duplicatePort = await fixture();
  duplicatePort.spec.capabilities.push({
    ...structuredClone(duplicatePort.spec.capabilities[1]),
    name: "quote-sidecar",
    binary: "quote-sidecar",
    mode: "sidecar",
    protocol: "grpc",
    endpoint: "127.0.0.1:3000",
    health: { kind: "grpc-health", requiredForReadiness: true },
  });
  delete duplicatePort.spec.capabilities[2].io;
  assert.throws(
    () => generateArtifacts(duplicatePort, [...bindingEntries, {
      logicalName: "quote-sidecar", binary: "quote", mode: "sidecar", label: "//:quote",
    }]),
    /ports must be pairwise unique/,
  );
});

test("accepts each closed invocation shape without adding a seventh", async () => {
  const cases = [
    {
      mode: "exec",
      protocol: "selamy.exec.v1",
      fields: {},
    },
    {
      mode: "sidecar",
      protocol: "grpc",
      fields: { endpoint: "127.0.0.1:4001", health: { kind: "grpc-health", requiredForReadiness: true } },
    },
    {
      mode: "job",
      protocol: "k8s.job.result.v1",
      fields: { health: { kind: "exec-exit", requiredForReadiness: false } },
    },
    {
      mode: "cronjob",
      protocol: "k8s.job.result.v1",
      fields: { schedule: "0 2 * * *", suspend: true },
    },
    {
      mode: "deployment",
      protocol: "grpc",
      fields: { endpoint: "quote-service:4002", replicas: 1, health: { kind: "grpc-health", requiredForReadiness: true } },
    },
  ];
  for (const scenario of cases) {
    const manifest = await fixture();
    const capability = manifest.spec.capabilities[1];
    capability.mode = scenario.mode;
    capability.protocol = scenario.protocol;
    Object.assign(capability, scenario.fields);
    if (!["exec"].includes(scenario.mode)) delete capability.io;
    const scenarioBindings = bindingEntries.map((binding) => (
      binding.logicalName === "price-normalizer" ? { ...binding, mode: scenario.mode } : binding
    ));
    const artifacts = generateArtifacts(manifest, scenarioBindings);
    assert.equal(JSON.parse(artifacts.catalog)[1].mode, scenario.mode);
  }

  const manifest = await fixture();
  manifest.spec.capabilities[1].mode = "worker";
  assert.throws(() => generateArtifacts(manifest, bindingEntries), /must be one of/);
});

test("rejects non-loopback sidecars and incomplete scheduled shapes", async () => {
  const sidecar = await fixture();
  Object.assign(sidecar.spec.capabilities[1], {
    mode: "sidecar",
    protocol: "grpc",
    endpoint: "10.0.0.1:4001",
    health: { kind: "grpc-health", requiredForReadiness: true },
  });
  delete sidecar.spec.capabilities[1].io;
  assert.throws(() => generateArtifacts(sidecar, bindingEntries), /within 127\.0\.0\.0\/8/);

  const cronjob = await fixture();
  Object.assign(cronjob.spec.capabilities[1], {
    mode: "cronjob",
    protocol: "k8s.job.result.v1",
    schedule: "0 2 * * *",
  });
  delete cronjob.spec.capabilities[1].io;
  assert.throws(() => generateArtifacts(cronjob, bindingEntries), /suspend: required for mode cronjob/);
});

test("records authority surfaces and requires their C3 consequence", async () => {
  const manifest = await fixture();
  manifest.spec.capabilities[1].permissions.network = ["market-data"];
  assert.throws(() => generateArtifacts(manifest, bindingEntries), /require C3/);
  manifest.spec.capabilities[1].consequenceClass = "C3";
  const artifacts = generateArtifacts(manifest, bindingEntries);
  assert.equal(JSON.parse(artifacts.catalog)[1].consequenceClass, "C3");
  assert.equal(artifacts.catalog.includes("market-data"), false);
});

test("manifest schema and generator agree on the local validation corpus", async () => {
  const manifestSchema = JSON.parse(
    await readFile(new URL("../schema/eve-agent-appliance-v1alpha1.schema.json", import.meta.url), "utf8"),
  );
  const base = await fixture();
  const instance = (mutate = () => {}) => {
    const manifest = structuredClone(base);
    mutate(manifest);
    return manifest;
  };
  const corpus = [
    { name: "base manifest", valid: true, manifest: instance() },
    {
      name: "telemetry correlation omitted",
      valid: true,
      manifest: instance((manifest) => delete manifest.spec.capabilities[1].telemetry.correlation),
    },
    {
      name: "path-shaped schema reference",
      valid: false,
      manifest: instance((manifest) => {
        manifest.spec.capabilities[1].io.inputSchemaRef = "../../schema/request.json";
      }),
    },
    {
      name: "exec protocol mismatch",
      valid: false,
      manifest: instance((manifest) => { manifest.spec.capabilities[1].protocol = "grpc"; }),
    },
    {
      name: "exec endpoint",
      valid: false,
      manifest: instance((manifest) => { manifest.spec.capabilities[1].endpoint = "127.0.0.1:4001"; }),
    },
    {
      name: "loopback grpc sidecar",
      valid: true,
      manifest: instance((manifest) => modeShape(manifest, "sidecar", "grpc", {
        endpoint: "127.1.2.3:4001",
        health: { kind: "grpc-health", requiredForReadiness: true },
      })),
    },
    {
      name: "non-loopback sidecar",
      valid: false,
      manifest: instance((manifest) => modeShape(manifest, "sidecar", "grpc", {
        endpoint: "10.0.0.1:4001",
        health: { kind: "grpc-health", requiredForReadiness: true },
      })),
    },
    {
      name: "REST sidecar",
      valid: false,
      manifest: instance((manifest) => modeShape(manifest, "sidecar", "rest", {
        endpoint: "127.0.0.1:4001",
        health: { kind: "grpc-health", requiredForReadiness: true },
      })),
    },
    {
      name: "job with health",
      valid: true,
      manifest: instance((manifest) => modeShape(manifest, "job", "k8s.job.result.v1", {
        health: { kind: "exec-exit", requiredForReadiness: false },
      })),
    },
    {
      name: "job endpoint",
      valid: false,
      manifest: instance((manifest) => modeShape(manifest, "job", "k8s.job.result.v1", {
        endpoint: "job-service:4001",
        health: { kind: "exec-exit", requiredForReadiness: false },
      })),
    },
    {
      name: "complete cronjob",
      valid: true,
      manifest: instance((manifest) => modeShape(manifest, "cronjob", "k8s.job.result.v1", {
        schedule: "0 2 * * *",
        suspend: true,
      })),
    },
    {
      name: "cronjob without suspend",
      valid: false,
      manifest: instance((manifest) => modeShape(manifest, "cronjob", "k8s.job.result.v1", {
        schedule: "0 2 * * *",
      })),
    },
    {
      name: "external REST deployment endpoint",
      valid: true,
      manifest: instance((manifest) => modeShape(manifest, "deployment", "rest", {
        endpoint: "quote-service:4002",
        replicas: 1,
        health: { kind: "http-get", requiredForReadiness: true },
      })),
    },
    {
      name: "deployment without endpoint",
      valid: false,
      manifest: instance((manifest) => modeShape(manifest, "deployment", "grpc", {
        health: { kind: "grpc-health", requiredForReadiness: true },
      })),
    },
    {
      name: "deployment endpoint outside port range",
      valid: false,
      manifest: instance((manifest) => modeShape(manifest, "deployment", "grpc", {
        endpoint: "quote-service:65536",
        health: { kind: "grpc-health", requiredForReadiness: true },
      })),
    },
    {
      name: "readiness without a health kind",
      valid: false,
      manifest: instance((manifest) => {
        manifest.spec.capabilities[1].health = { requiredForReadiness: true };
      }),
    },
    {
      name: "authority surface below C3",
      valid: false,
      manifest: instance((manifest) => { manifest.spec.capabilities[1].permissions.network = ["market-data"]; }),
    },
    {
      name: "approval floor violation",
      valid: false,
      manifest: instance((manifest) => {
        manifest.spec.capabilities[1].approvalClass = "consequential-bounded";
      }),
    },
  ];

  const schemaAcceptance = validateWithJsonSchema(manifestSchema, corpus.map(({ manifest }) => manifest));
  for (const [index, scenario] of corpus.entries()) {
    assert.equal(schemaAcceptance[index], scenario.valid, `${scenario.name}: schema acceptance`);
    const capabilityMode = scenario.manifest.spec.capabilities[1].mode;
    const bindings = bindingEntries.map((binding) => (
      binding.logicalName === "price-normalizer" ? { ...binding, mode: capabilityMode } : binding
    ));
    let generatorAccepted = true;
    try {
      generateArtifacts(scenario.manifest, bindings);
    } catch {
      generatorAccepted = false;
    }
    assert.equal(generatorAccepted, scenario.valid, `${scenario.name}: generator acceptance`);
  }

  const withoutCorrelation = corpus.find(({ name }) => name === "telemetry correlation omitted").manifest;
  const canonical = JSON.parse(generateArtifacts(withoutCorrelation, bindingEntries).canonicalManifest);
  assert.equal(Object.hasOwn(canonical.spec.capabilities[1].telemetry, "correlation"), false);
  const execSchema = JSON.parse(
    await readFile(new URL("../schema/selamy-exec-v1.schema.json", import.meta.url), "utf8"),
  );
  assert.equal(manifestSchema.additionalProperties, false);
  assert.deepEqual(manifestSchema.$defs.capability.properties.mode.enum, [
    "in_process", "exec", "sidecar", "job", "cronjob", "deployment",
  ]);
  assert.equal(execSchema.oneOf.length, 3);
});

test("selamy.exec.v1 schema exactly accepts the Nova N1 wire corpus", async () => {
  const execSchema = JSON.parse(
    await readFile(new URL("../schema/selamy-exec-v1.schema.json", import.meta.url), "utf8"),
  );
  const request = {
    body: { price_minor: 123456, rounding: "nearest_even", tick_minor: 25 },
    capability: "price-normalizer",
    protocol: "selamy.exec.v1",
    version: 1,
  };
  const success = {
    body: { normalized_minor: 123450, steps: 4938 },
    protocol: "selamy.exec.v1",
    status: "ok",
    version: 1,
  };
  const failure = {
    error: { class: "out_of_range", field: "price_minor" },
    protocol: "selamy.exec.v1",
    status: "error",
    version: 1,
  };
  const corpus = [
    { name: "N1 request", valid: true, envelope: request },
    { name: "N1 success", valid: true, envelope: success },
    {
      name: "round-up result above maximum input price",
      valid: true,
      envelope: {
        ...success,
        body: { normalized_minor: 1000999999998999, steps: 1001 },
      },
    },
    { name: "N1 typed failure", valid: true, envelope: failure },
    {
      name: "failure without optional field",
      valid: true,
      envelope: { ...failure, error: { class: "internal" } },
    },
    {
      name: "generic capability",
      valid: false,
      envelope: { ...request, capability: "portfolio-view" },
    },
    {
      name: "unknown request body field",
      valid: false,
      envelope: { ...request, body: { ...request.body, currency: "USD" } },
    },
    {
      name: "price outside N1 bound",
      valid: false,
      envelope: { ...request, body: { ...request.body, price_minor: 1000000000000001 } },
    },
    {
      name: "unknown rounding mode",
      valid: false,
      envelope: { ...request, body: { ...request.body, rounding: "nearest" } },
    },
    {
      name: "legacy hyphenated error class",
      valid: false,
      envelope: { ...failure, error: { class: "invalid-envelope" } },
    },
    {
      name: "free-text error message",
      valid: false,
      envelope: { ...failure, error: { class: "out_of_range", message: "too large" } },
    },
    {
      name: "unsupported envelope version",
      valid: false,
      envelope: { ...request, version: 2 },
    },
  ];
  const acceptance = validateWithJsonSchema(execSchema, corpus.map(({ envelope }) => envelope));
  for (const [index, scenario] of corpus.entries()) {
    assert.equal(acceptance[index], scenario.valid, scenario.name);
  }
});
