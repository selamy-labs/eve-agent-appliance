import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { generateDigestEvidence, verifyOciImage } from "../src/digest-evidence.mjs";

const execFileAsync = promisify(execFile);
const expectedPlatform = { architecture: "amd64", os: "linux" };

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

function tarEntry(path, bytes = Buffer.alloc(0), mode = 0o444, type = "0", linkPath = "") {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(10_001, 8), 108, 8, "ascii");
  header.write(octal(10_001, 8), 116, 8, "ascii");
  header.write(octal(bytes.length, 12), 124, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write(linkPath, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = body.length + 2;
  while (`${length} ${body}`.length !== length) length = `${length} ${body}`.length;
  return Buffer.from(`${length} ${body}`);
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function writeBlob(layout, bytes) {
  const value = digest(bytes);
  await writeFile(join(layout, "blobs", "sha256", value.slice(7)), bytes);
  return { digest: value, size: bytes.length };
}

async function ociFixture(layers, options = {}) {
  const layout = await mkdtemp(join(tmpdir(), "eve-appliance-oci-"));
  await mkdir(join(layout, "blobs", "sha256"), { recursive: true });
  await writeFile(join(layout, "oci-layout"), JSON.stringify({
    imageLayoutVersion: options.layoutVersion ?? "1.0.0",
  }));
  const layerDescriptors = [];
  const diffIds = [];
  for (const [index, entries] of layers.entries()) {
    const archive = Buffer.concat([...entries, Buffer.alloc(1024)]);
    const mediaType = options.layerMediaTypes?.[index] ?? "application/vnd.oci.image.layer.v1.tar";
    const blob = mediaType.endsWith("+gzip") ? gzipSync(archive, { mtime: 0 }) : archive;
    const descriptor = await writeBlob(layout, blob);
    layerDescriptors.push({ ...descriptor, mediaType });
    diffIds.push(digest(archive));
  }
  const config = options.configBytes ?? Buffer.from(JSON.stringify({
    architecture: options.architecture ?? "amd64",
    os: options.os ?? "linux",
    rootfs: {
      diff_ids: options.diffIds ?? diffIds,
      type: "layers",
    },
  }));
  const configDescriptor = await writeBlob(layout, config);
  const manifest = Buffer.from(JSON.stringify({
    mediaType: options.manifestMediaType ?? "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
    config: options.omitConfig ? undefined : {
      ...configDescriptor,
      mediaType: options.configMediaType ?? "application/vnd.oci.image.config.v1+json",
      size: options.configSize ?? configDescriptor.size,
    },
    layers: layerDescriptors,
  }));
  const manifestDescriptor = await writeBlob(layout, manifest);
  await writeFile(join(layout, "index.json"), JSON.stringify({
    mediaType: options.indexMediaType ?? "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
    manifests: [{
      ...manifestDescriptor,
      mediaType: options.manifestDescriptorMediaType ?? "application/vnd.oci.image.manifest.v1+json",
    }],
  }));
  return { configDigest: configDescriptor.digest, imageDigest: manifestDescriptor.digest, layout };
}

test("derives the digest from an OCI layout only after matching required runtime bytes", async () => {
  const source = Buffer.from("runtime\n");
  const sourceDir = await mkdtemp(join(tmpdir(), "eve-appliance-source-"));
  const sourceFile = join(sourceDir, "runtime");
  await writeFile(sourceFile, source);
  const { imageDigest: expected, layout } = await ociFixture([[
    tarEntry("opt/selamy/bin/runtime", source, 0o555),
  ]]);
  try {
    assert.equal(
      await verifyOciImage(layout, [{ expectedMode: "0555", imagePath: "/opt/selamy/bin/runtime", sourceFile }], expectedPlatform),
      expected,
    );
    await assert.rejects(
      verifyOciImage(layout, [{ expectedMode: "0444", imagePath: "/opt/selamy/bin/runtime", sourceFile }], expectedPlatform),
      /unexpected mode or ownership/,
    );
    await assert.rejects(
      verifyOciImage(layout, [{ imagePath: "/opt/selamy/bin/runtime", sourceFile }], expectedPlatform),
      /declare an expected octal mode/,
    );
    await writeFile(sourceFile, "different\n");
    await assert.rejects(
      verifyOciImage(layout, [{ expectedMode: "0555", imagePath: "/opt/selamy/bin/runtime", sourceFile }], expectedPlatform),
      /does not match its Bazel source/,
    );
    await assert.rejects(
      verifyOciImage(layout, [{ expectedMode: "0555", imagePath: "/opt/selamy/bin/missing", sourceFile }], expectedPlatform),
      /missing required runtime file/,
    );
  } finally {
    await Promise.all([rm(layout, { recursive: true, force: true }), rm(sourceDir, { recursive: true, force: true })]);
  }
});

test("an independently reproduced upper-layer symlink replaces a lower regular file", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "eve-appliance-source-"));
  const sourceFile = join(sourceDir, "runtime");
  const source = Buffer.from("runtime\n");
  await writeFile(sourceFile, source);
  const { layout } = await ociFixture([
    [tarEntry("opt/selamy/bin/runtime", source, 0o555)],
    [tarEntry("opt/selamy/bin/runtime", Buffer.alloc(0), 0o777, "2", "elsewhere")],
  ]);
  try {
    await assert.rejects(
      verifyOciImage(layout, [{ expectedMode: "0555", imagePath: "/opt/selamy/bin/runtime", sourceFile }], expectedPlatform),
      /must be a regular file/,
    );
  } finally {
    await Promise.all([
      rm(layout, { recursive: true, force: true }),
      rm(sourceDir, { recursive: true, force: true }),
    ]);
  }
});

test("upper-layer hardlink, directory, and special entries replace lower regular files", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "eve-appliance-source-"));
  const sourceFile = join(sourceDir, "runtime");
  const source = Buffer.from("runtime\n");
  await writeFile(sourceFile, source);
  for (const replacement of [
    tarEntry("opt/selamy/bin/runtime", Buffer.alloc(0), 0o777, "1", "opt/selamy/bin/other"),
    tarEntry("opt/selamy/bin/runtime", Buffer.alloc(0), 0o755, "5"),
    tarEntry("opt/selamy/bin/runtime", Buffer.alloc(0), 0o600, "6"),
  ]) {
    const { layout } = await ociFixture([
      [tarEntry("opt/selamy/bin/runtime", source, 0o555)],
      [replacement],
    ]);
    try {
      await assert.rejects(
        verifyOciImage(layout, [{ expectedMode: "0555", imagePath: "/opt/selamy/bin/runtime", sourceFile }], expectedPlatform),
        /must be a regular file/,
      );
    } finally {
      await rm(layout, { recursive: true, force: true });
    }
  }
  await rm(sourceDir, { recursive: true, force: true });
});

test("whiteouts still remove lower regular files", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "eve-appliance-source-"));
  const sourceFile = join(sourceDir, "runtime");
  const source = Buffer.from("runtime\n");
  await writeFile(sourceFile, source);
  const { layout } = await ociFixture([
    [tarEntry("opt/selamy/bin/runtime", source, 0o555)],
    [tarEntry("opt/selamy/bin/.wh.runtime")],
  ]);
  try {
    await assert.rejects(
      verifyOciImage(layout, [{ expectedMode: "0555", imagePath: "/opt/selamy/bin/runtime", sourceFile }], expectedPlatform),
      /missing required runtime file/,
    );
  } finally {
    await Promise.all([
      rm(layout, { recursive: true, force: true }),
      rm(sourceDir, { recursive: true, force: true }),
    ]);
  }
});

test("a whiteout never erases a replacement created in the same layer", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "eve-appliance-source-"));
  const sourceFile = join(sourceDir, "runtime");
  const replacement = Buffer.from("replacement\n");
  await writeFile(sourceFile, replacement);
  const { imageDigest: expected, layout } = await ociFixture([
    [tarEntry("opt/selamy/bin/runtime", Buffer.from("lower\n"), 0o555)],
    [
      tarEntry("opt/selamy/bin/runtime", replacement, 0o555),
      tarEntry("opt/selamy/bin/.wh.runtime"),
    ],
  ]);
  try {
    assert.equal(
      await verifyOciImage(layout, [{ expectedMode: "0555", imagePath: "/opt/selamy/bin/runtime", sourceFile }], expectedPlatform),
      expected,
    );
  } finally {
    await Promise.all([
      rm(layout, { recursive: true, force: true }),
      rm(sourceDir, { recursive: true, force: true }),
    ]);
  }
});

test("binds config rootfs diff_ids to each uncompressed layer", async () => {
  const mismatch = await ociFixture([[tarEntry("runtime", Buffer.from("runtime\n"))]], {
    diffIds: [`sha256:${"0".repeat(64)}`],
  });
  try {
    await assert.rejects(verifyOciImage(mismatch.layout, [], expectedPlatform), /rootfs\.diff_ids\[0\]/);
  } finally {
    await rm(mismatch.layout, { recursive: true, force: true });
  }

  const gzip = await ociFixture([[tarEntry("runtime", Buffer.from("runtime\n"))]], {
    layerMediaTypes: ["application/vnd.oci.image.layer.v1.tar+gzip"],
  });
  try {
    assert.equal(await verifyOciImage(gzip.layout, [], expectedPlatform), gzip.imageDigest);
  } finally {
    await rm(gzip.layout, { recursive: true, force: true });
  }
});

test("honors local PAX ownership overrides", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "eve-appliance-source-"));
  const sourceFile = join(sourceDir, "runtime");
  const source = Buffer.from("runtime\n");
  await writeFile(sourceFile, source);
  const pax = Buffer.concat([paxRecord("uid", "0"), paxRecord("gid", "0")]);
  const { layout } = await ociFixture([[
    tarEntry("PaxHeader/runtime", pax, 0o444, "x"),
    tarEntry("opt/selamy/bin/runtime", source, 0o555),
  ]]);
  try {
    await assert.rejects(
      verifyOciImage(layout, [{ expectedMode: "0555", imagePath: "/opt/selamy/bin/runtime", sourceFile }], expectedPlatform),
      /unexpected mode or ownership/,
    );
  } finally {
    await Promise.all([
      rm(layout, { recursive: true, force: true }),
      rm(sourceDir, { recursive: true, force: true }),
    ]);
  }
});

test("explicitly rejects unsupported layer media types and global PAX headers", async () => {
  const zstd = await ociFixture([[]], {
    layerMediaTypes: ["application/vnd.oci.image.layer.v1.tar+zstd"],
  });
  try {
    await assert.rejects(verifyOciImage(zstd.layout, [], expectedPlatform), /unsupported media type/);
  } finally {
    await rm(zstd.layout, { recursive: true, force: true });
  }

  const globalPax = await ociFixture([[
    tarEntry("GlobalHead", paxRecord("uid", "0"), 0o444, "g"),
    tarEntry("runtime", Buffer.from("runtime\n")),
  ]]);
  try {
    await assert.rejects(verifyOciImage(globalPax.layout, [], expectedPlatform), /global PAX/);
  } finally {
    await rm(globalPax.layout, { recursive: true, force: true });
  }
});

test("rejects missing or invalid OCI layout and config metadata", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "eve-appliance-source-"));
  const sourceFile = join(sourceDir, "runtime");
  await writeFile(sourceFile, "runtime\n");
  const requirement = [{ expectedMode: "0555", imagePath: "/opt/selamy/bin/runtime", sourceFile }];
  const layouts = [];
  try {
    const missingLayout = await ociFixture([[tarEntry("opt/selamy/bin/runtime", Buffer.from("runtime\n"), 0o555)]]);
    layouts.push(missingLayout.layout);
    await rm(join(missingLayout.layout, "oci-layout"));
    await assert.rejects(verifyOciImage(missingLayout.layout, requirement, expectedPlatform), /oci-layout/);

    const invalidLayout = await ociFixture([], { layoutVersion: "0.9.0" });
    layouts.push(invalidLayout.layout);
    await assert.rejects(verifyOciImage(invalidLayout.layout, requirement, expectedPlatform), /imageLayoutVersion/);

    const invalidConfig = await ociFixture([[]], { configBytes: Buffer.from("not json") });
    layouts.push(invalidConfig.layout);
    await assert.rejects(verifyOciImage(invalidConfig.layout, requirement, expectedPlatform), /config blob.*valid JSON/);

    const missingConfig = await ociFixture([[]], { omitConfig: true });
    layouts.push(missingConfig.layout);
    await assert.rejects(verifyOciImage(missingConfig.layout, requirement, expectedPlatform), /manifest\.config/);

    const invalidConfigMediaType = await ociFixture([[]], { configMediaType: "application/json" });
    layouts.push(invalidConfigMediaType.layout);
    await assert.rejects(
      verifyOciImage(invalidConfigMediaType.layout, requirement, expectedPlatform),
      /manifest\.config\.mediaType/,
    );
  } finally {
    await Promise.all([
      rm(sourceDir, { recursive: true, force: true }),
      ...layouts.map((layout) => rm(layout, { recursive: true, force: true })),
    ]);
  }
});

test("rejects an OCI config for a different platform", async () => {
  const { layout } = await ociFixture([[]], { architecture: "arm64" });
  try {
    await assert.rejects(verifyOciImage(layout, [], expectedPlatform), /does not match expected linux\/amd64/);
  } finally {
    await rm(layout, { recursive: true, force: true });
  }
});

test("rejects invalid index, manifest, and config descriptor media types", async () => {
  const cases = [
    [{ indexMediaType: "application/json" }, /index\.json\.mediaType/],
    [{ manifestDescriptorMediaType: "application/json" }, /index\.manifests\[0\]\.mediaType/],
    [{ manifestMediaType: "application/json" }, /image manifest\.mediaType/],
    [{ configMediaType: "application/json" }, /manifest\.config\.mediaType/],
  ];
  for (const [options, pattern] of cases) {
    const { layout } = await ociFixture([[]], options);
    try {
      await assert.rejects(verifyOciImage(layout, [], expectedPlatform), pattern);
    } finally {
      await rm(layout, { recursive: true, force: true });
    }
  }
});

test("verifies config descriptor size and digest before trusting the config", async () => {
  const wrongSize = await ociFixture([[]], { configSize: 1 });
  try {
    await assert.rejects(verifyOciImage(wrongSize.layout, [], expectedPlatform), /config blob size mismatch/);
  } finally {
    await rm(wrongSize.layout, { recursive: true, force: true });
  }

  const tampered = await ociFixture([[]]);
  try {
    await writeFile(join(tampered.layout, "blobs", "sha256", tampered.configDigest.slice(7)), "tampered");
    await assert.rejects(verifyOciImage(tampered.layout, [], expectedPlatform), /config blob digest mismatch/);
  } finally {
    await rm(tampered.layout, { recursive: true, force: true });
  }
});

test("CLI rejects unknown flags", async () => {
  const script = join(import.meta.dirname, "..", "src", "digest-evidence.mjs");
  await assert.rejects(
    execFileAsync(process.execPath, [script, "--unknown", "value"]),
    (error) => error.code === 1 && /unknown argument --unknown/.test(error.stderr),
  );
});
