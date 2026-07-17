import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { canonicalJson } from "../src/canonical-json.mjs";
import {
  EXEC_OUTPUT_BYTE_CAP,
  SCHEMA_VERSION,
  generateArtifacts,
} from "../src/generate.mjs";

const fixtureUrl = new URL("fixtures/nova.yaml", import.meta.url);
const bindingEntries = [
  { logicalName: "eve", binary: "eve-runtime.txt", label: "//:eve_runtime" },
  {
    logicalName: "price-normalizer",
    binary: "price-normalizer.txt",
    label: "//:price_normalizer",
  },
];

async function fixture() {
  return parse(await readFile(fixtureUrl, "utf8"));
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
    { logicalName: "portfolio-view", binary: "portfolio.txt", label: "//:portfolio_view" },
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
    () => generateArtifacts(duplicatePort, [...bindingEntries, { logicalName: "quote-sidecar", binary: "quote", label: "//:quote" }]),
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
    const artifacts = generateArtifacts(manifest, bindingEntries);
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

test("schema documents retain closed roots and all six invocation modes", async () => {
  const manifestSchema = JSON.parse(
    await readFile(new URL("../schema/eve-agent-appliance-v1alpha1.schema.json", import.meta.url), "utf8"),
  );
  const execSchema = JSON.parse(
    await readFile(new URL("../schema/selamy-exec-v1.schema.json", import.meta.url), "utf8"),
  );
  assert.equal(manifestSchema.additionalProperties, false);
  assert.deepEqual(manifestSchema.$defs.capability.properties.mode.enum, [
    "in_process", "exec", "sidecar", "job", "cronjob", "deployment",
  ]);
  assert.equal(execSchema.oneOf.length, 3);
});
