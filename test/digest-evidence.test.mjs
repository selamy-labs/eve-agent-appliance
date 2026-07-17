import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDigestEvidence } from "../src/digest-evidence.mjs";

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
