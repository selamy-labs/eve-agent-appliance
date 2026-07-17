#!/usr/bin/env node

import { cp, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const [sourceLayout, canonicalManifest, outputLayout] = process.argv.slice(2);
if (!sourceLayout || !canonicalManifest || !outputLayout) {
  throw new TypeError("expected source layout, canonical manifest, and output layout paths");
}

JSON.parse(await readFile(canonicalManifest, "utf8"));
for (const entry of await readdir(sourceLayout)) {
  await cp(join(sourceLayout, entry), join(outputLayout, entry), {
    errorOnExist: true,
    force: false,
    recursive: true,
  });
}
