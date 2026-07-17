import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateDigestEvidence, verifyOciImage } from "../src/digest-evidence.mjs";

const manifestDigest = `sha256:${"a".repeat(64)}`;
const imageDigest = `sha256:${"b".repeat(64)}`;
const binding = [
  { id: "nova.eve.v1", label: "//:eve", manifestDigest },
  { id: "nova.price-normalizer.v1", label: "//:normalizer", manifestDigest },
];

test("correlates each capability to the post-build image digest canonically", () => {
  const evidence = generateDigestEvidence(binding, `${imageDigest}\n`);
  assert.deepEqual(JSON.parse(evidence), {
    "nova.eve.v1": { imageDigest, label: "//:eve", manifestDigest },
    "nova.price-normalizer.v1": {
      imageDigest,
      label: "//:normalizer",
      manifestDigest,
    },
  });
  assert.equal(evidence.endsWith("\n"), false);
});

test("fails closed on invalid digests, duplicate IDs, and circular binding input", () => {
  assert.throws(() => generateDigestEvidence(binding, "latest"), /image digest/);
  assert.throws(() => generateDigestEvidence([...binding, binding[0]], imageDigest), /duplicate capability id/);
  assert.throws(
    () => generateDigestEvidence([{ ...binding[0], imageDigest }], imageDigest),
    /must not contain imageDigest/,
  );
});

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function tarFile(path, bytes, mode = 0o444) {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(10_001, 8), 108, 8, "ascii");
  header.write(octal(10_001, 8), 116, 8, "ascii");
  header.write(octal(bytes.length, 12), 124, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function writeBlob(layout, bytes) {
  const value = digest(bytes);
  await writeFile(join(layout, "blobs", "sha256", value.slice(7)), bytes);
  return { digest: value, size: bytes.length };
}

async function ociFixture(files) {
  const layout = await mkdtemp(join(tmpdir(), "eve-appliance-oci-"));
  await mkdir(join(layout, "blobs", "sha256"), { recursive: true });
  const entries = Object.entries(files).map(([path, { bytes, mode }]) => tarFile(path, bytes, mode));
  const layer = Buffer.concat([...entries, Buffer.alloc(1024)]);
  const layerDescriptor = await writeBlob(layout, layer);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    layers: [{ ...layerDescriptor, mediaType: "application/vnd.oci.image.layer.v1.tar" }],
  }));
  const manifestDescriptor = await writeBlob(layout, manifest);
  await writeFile(join(layout, "index.json"), JSON.stringify({
    schemaVersion: 2,
    manifests: [{ ...manifestDescriptor, mediaType: "application/vnd.oci.image.manifest.v1+json" }],
  }));
  return { imageDigest: manifestDescriptor.digest, layout };
}

test("derives the digest from an OCI layout only after matching required runtime bytes", async () => {
  const source = Buffer.from("runtime\n");
  const sourceDir = await mkdtemp(join(tmpdir(), "eve-appliance-source-"));
  const sourceFile = join(sourceDir, "runtime");
  await writeFile(sourceFile, source);
  const { imageDigest: expected, layout } = await ociFixture({
    "opt/selamy/bin/runtime": { bytes: source, mode: 0o555 },
  });
  try {
    assert.equal(
      await verifyOciImage(layout, [{ imagePath: "/opt/selamy/bin/runtime", sourceFile }]),
      expected,
    );
    await writeFile(sourceFile, "different\n");
    await assert.rejects(
      verifyOciImage(layout, [{ imagePath: "/opt/selamy/bin/runtime", sourceFile }]),
      /does not match its Bazel source/,
    );
    await assert.rejects(
      verifyOciImage(layout, [{ imagePath: "/opt/selamy/bin/missing", sourceFile }]),
      /missing required runtime file/,
    );
  } finally {
    await Promise.all([rm(layout, { recursive: true, force: true }), rm(sourceDir, { recursive: true, force: true })]);
  }
});
