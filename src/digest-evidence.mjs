#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { canonicalJson } from "./canonical-json.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CAPABILITY_ID = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?\.[a-z][a-z0-9-]{0,61}[a-z0-9]\.v[1-9][0-9]*$/;
const BLOCK_SIZE = 512;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireDigest(value, path) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${path} must be sha256:<64 lowercase hex>`);
  }
  return value;
}

function readTarString(block, offset, length) {
  const end = block.indexOf(0, offset);
  const boundedEnd = end === -1 || end > offset + length ? offset + length : end;
  return block.subarray(offset, boundedEnd).toString("utf8");
}

function readTarOctal(block, offset, length, path) {
  const raw = readTarString(block, offset, length).trim();
  if (!/^[0-7]+$/.test(raw)) throw new TypeError(`${path} has invalid tar integer ${JSON.stringify(raw)}`);
  return Number.parseInt(raw, 8);
}

function normalizeImagePath(value) {
  const normalized = value.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/$/, "");
  if (!normalized || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`unsafe image path ${JSON.stringify(value)}`);
  }
  return normalized;
}

function parsePax(bytes) {
  const attributes = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) throw new TypeError("invalid PAX record length");
    const length = Number(bytes.subarray(offset, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length) {
      throw new TypeError("invalid PAX record boundary");
    }
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) throw new TypeError("invalid PAX record");
    attributes[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return attributes;
}

function applyWhiteout(files, path) {
  const parts = path.split("/");
  const name = parts.pop();
  const directory = parts.join("/");
  if (name === ".wh..wh..opq") {
    const prefix = directory ? `${directory}/` : "";
    for (const candidate of files.keys()) if (candidate.startsWith(prefix)) files.delete(candidate);
    return true;
  }
  if (!name.startsWith(".wh.")) return false;
  const target = [...parts, name.slice(4)].filter(Boolean).join("/");
  files.delete(target);
  for (const candidate of files.keys()) if (candidate.startsWith(`${target}/`)) files.delete(candidate);
  return true;
}

function applyTarLayer(files, archive) {
  let offset = 0;
  let pax = {};
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) return;
    const size = readTarOctal(header, 124, 12, "tar header size");
    const mode = readTarOctal(header, 100, 8, "tar header mode");
    const uid = readTarOctal(header, 108, 8, "tar header uid");
    const gid = readTarOctal(header, 116, 8, "tar header gid");
    const type = String.fromCharCode(header[156] || 0);
    const prefix = readTarString(header, 345, 155);
    const name = readTarString(header, 0, 100);
    const rawPath = pax.path ?? (prefix ? `${prefix}/${name}` : name);
    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new TypeError("tar entry exceeds layer boundary");
    const bytes = archive.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (type === "x") {
      pax = parsePax(bytes);
      continue;
    }
    const path = normalizeImagePath(rawPath);
    pax = {};
    if (applyWhiteout(files, path)) continue;
    if (type === "\0" || type === "0" || type === "7") {
      files.set(path, { bytes: Buffer.from(bytes), gid, mode, uid });
    } else if (!["1", "2", "5", "g"].includes(type)) {
      throw new TypeError(`unsupported tar entry type ${JSON.stringify(type)} for ${path}`);
    }
  }
  throw new TypeError("tar layer has no zero-block terminator");
}

async function readVerifiedBlob(layout, descriptor, path) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new TypeError(`${path} must be an OCI descriptor`);
  }
  const digest = requireDigest(descriptor.digest, `${path}.digest`);
  const bytes = await readFile(join(layout, "blobs", "sha256", digest.slice("sha256:".length)));
  if (sha256(bytes) !== digest) throw new TypeError(`${path} blob digest mismatch`);
  if (descriptor.size !== bytes.length) throw new TypeError(`${path} blob size mismatch`);
  return bytes;
}

export async function verifyOciImage(layout, requiredFiles) {
  const indexBytes = await readFile(join(layout, "index.json"));
  const index = JSON.parse(indexBytes);
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new TypeError("OCI layout must contain exactly one schemaVersion 2 image manifest");
  }
  const manifestDescriptor = index.manifests[0];
  const manifestBytes = await readVerifiedBlob(layout, manifestDescriptor, "index.manifests[0]");
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    throw new TypeError("OCI image manifest must contain at least one layer");
  }

  const files = new Map();
  for (const [index, descriptor] of manifest.layers.entries()) {
    const compressed = await readVerifiedBlob(layout, descriptor, `manifest.layers[${index}]`);
    let archive;
    if (descriptor.mediaType?.endsWith("+gzip")) archive = gunzipSync(compressed);
    else if (descriptor.mediaType?.endsWith(".tar")) archive = compressed;
    else throw new TypeError(`manifest.layers[${index}] has unsupported media type ${descriptor.mediaType}`);
    applyTarLayer(files, archive);
  }

  for (const requirement of requiredFiles) {
    const path = normalizeImagePath(requirement.imagePath);
    const actual = files.get(path);
    if (!actual) throw new TypeError(`OCI image is missing required runtime file /${path}`);
    const expectedBytes = await readFile(requirement.sourceFile);
    if (sha256(actual.bytes) !== sha256(expectedBytes)) {
      throw new TypeError(`OCI image runtime file /${path} does not match its Bazel source`);
    }
    const expectedMode = path.startsWith("opt/selamy/bin/") && !path.includes(".runfiles/") && !path.endsWith(".repo_mapping")
      ? 0o555
      : 0o444;
    if ((actual.mode & 0o7777) !== expectedMode || actual.uid !== 10_001 || actual.gid !== 10_001) {
      throw new TypeError(`OCI image runtime file /${path} has unexpected mode or ownership`);
    }
  }
  return manifestDescriptor.digest;
}

export function generateDigestEvidence(bindingManifest, imageDigest) {
  if (!Array.isArray(bindingManifest) || bindingManifest.length === 0) {
    throw new TypeError("binding manifest must be a non-empty array");
  }
  const digest = requireDigest(imageDigest.trim(), "image digest");
  const evidence = {};
  for (const [index, binding] of bindingManifest.entries()) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw new TypeError(`binding ${index} must be an object`);
    }
    if (!CAPABILITY_ID.test(binding.id)) throw new TypeError(`binding ${index} has invalid capability id`);
    if (Object.hasOwn(binding, "imageDigest")) throw new TypeError(`binding ${index} must not contain imageDigest`);
    if (typeof binding.label !== "string" || binding.label.length === 0) {
      throw new TypeError(`binding ${index} has invalid label`);
    }
    requireDigest(binding.manifestDigest, `binding ${index} manifest digest`);
    if (Object.hasOwn(evidence, binding.id)) throw new TypeError(`duplicate capability id ${binding.id}`);
    evidence[binding.id] = {
      label: binding.label,
      manifestDigest: binding.manifestDigest,
      imageDigest: digest,
    };
  }
  return canonicalJson(evidence);
}

function parseArguments(argv) {
  const scalar = new Map();
  const requiredFiles = [];
  let pendingPath;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new TypeError(`invalid argument at index ${index}`);
    if (flag === "--image-path") {
      if (pendingPath !== undefined) throw new TypeError("image path repeated before source file");
      pendingPath = value;
    } else if (flag === "--source-file") {
      if (pendingPath === undefined) throw new TypeError("source file requires a preceding image path");
      requiredFiles.push({ imagePath: pendingPath, sourceFile: value });
      pendingPath = undefined;
    } else {
      if (scalar.has(flag)) throw new TypeError(`duplicate ${flag}`);
      scalar.set(flag, value);
    }
  }
  if (pendingPath !== undefined) throw new TypeError("incomplete image file requirement");
  for (const flag of ["--binding-manifest", "--oci-layout", "--output"]) {
    if (!scalar.has(flag)) throw new TypeError(`missing ${flag}`);
  }
  if (requiredFiles.length === 0) throw new TypeError("at least one required image file is required");
  return { requiredFiles, scalar };
}

async function main() {
  const { requiredFiles, scalar } = parseArguments(process.argv.slice(2));
  const bindingSource = await readFile(scalar.get("--binding-manifest"), "utf8");
  const imageDigest = await verifyOciImage(scalar.get("--oci-layout"), requiredFiles);
  const evidence = generateDigestEvidence(JSON.parse(bindingSource), imageDigest);
  await writeFile(scalar.get("--output"), evidence, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
