#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./canonical-json.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CAPABILITY_ID = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?\.[a-z][a-z0-9-]{0,61}[a-z0-9]\.v[1-9][0-9]*$/;

export function generateDigestEvidence(bindingManifest, imageDigest) {
  if (!Array.isArray(bindingManifest) || bindingManifest.length === 0) {
    throw new TypeError("binding manifest must be a non-empty array");
  }
  const digest = imageDigest.trim();
  if (!DIGEST.test(digest)) throw new TypeError("image digest must be sha256:<64 lowercase hex>");
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
    if (!DIGEST.test(binding.manifestDigest)) {
      throw new TypeError(`binding ${index} has invalid manifest digest`);
    }
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
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || values.has(flag)) {
      throw new TypeError(`invalid argument at index ${index}`);
    }
    values.set(flag, value);
  }
  for (const flag of ["--binding-manifest", "--image-digest", "--output"]) {
    if (!values.has(flag)) throw new TypeError(`missing ${flag}`);
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const [bindingSource, digestSource] = await Promise.all([
    readFile(args.get("--binding-manifest"), "utf8"),
    readFile(args.get("--image-digest"), "utf8"),
  ]);
  const evidence = generateDigestEvidence(JSON.parse(bindingSource), digestSource);
  await writeFile(args.get("--output"), evidence, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
