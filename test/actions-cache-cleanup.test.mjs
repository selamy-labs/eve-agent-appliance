import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { enforceCacheLifetime, listCaches } from "../scripts/actions-cache-cleanup.mjs";

const repository = "selamy-labs/eve-agent-appliance";
const token = "test-token";
const now = new Date("2026-07-17T12:00:00Z");

function response(payload, status = 200) {
  return new Response(status === 200 ? JSON.stringify(payload) : String(payload), { status });
}

function sequence(items, requests = []) {
  let index = 0;
  return {
    requests,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method ?? "GET" });
      const item = items[index++];
      if (!item) throw new Error("unexpected request");
      return typeof item === "function" ? item() : item;
    },
  };
}

const old = { id: 1, last_accessed_at: "2026-07-16T11:59:59Z" };
const boundary = { id: 2, last_accessed_at: "2026-07-16T12:00:00Z" };

test("deletes only entries strictly older than 24 hours after two stable inventories", async () => {
  const page = { total_count: 2, actions_caches: [old, boundary] };
  const { fetchImpl, requests } = sequence([
    response(page), response(page), new Response(null, { status: 204 }),
  ]);
  const result = await enforceCacheLifetime({ repository, token, now, fetchImpl });
  assert.deepEqual(result.eligibleIds, [1]);
  assert.deepEqual(result.deletedIds, [1]);
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET", "DELETE"]);
});

test("dry-run never deletes", async () => {
  const page = { total_count: 1, actions_caches: [old] };
  const { fetchImpl, requests } = sequence([response(page), response(page)]);
  const result = await enforceCacheLifetime({ repository, token, now, dryRun: true, fetchImpl });
  assert.deepEqual(result.eligibleIds, [1]);
  assert.deepEqual(result.deletedIds, []);
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET"]);
});

test("preserves nanosecond precision at the strict 24-hour cutoff", async () => {
  const justOld = { id: 3, last_accessed_at: "2026-07-16T11:59:59.999999999Z" };
  const justFresh = { id: 4, last_accessed_at: "2026-07-16T12:00:00.000000001Z" };
  const page = { total_count: 2, actions_caches: [justOld, justFresh] };
  const { fetchImpl } = sequence([response(page), response(page)]);
  const result = await enforceCacheLifetime({ repository, token, now, dryRun: true, fetchImpl });
  assert.deepEqual(result.eligibleIds, [3]);
});

test("fails closed before delete when the confirming inventory changes", async () => {
  const first = { total_count: 1, actions_caches: [old] };
  const changed = { total_count: 1, actions_caches: [{ ...old, last_accessed_at: "2026-07-17T11:00:00Z" }] };
  const { fetchImpl, requests } = sequence([response(first), response(changed)]);
  await assert.rejects(
    enforceCacheLifetime({ repository, token, now, fetchImpl }),
    /changed between confirmation passes/,
  );
  assert.equal(requests.some(({ method }) => method === "DELETE"), false);
});

test("requires exact API status and sorted unique records", async () => {
  await assert.rejects(
    listCaches({ repository, token, fetchImpl: async () => response("unauthorized", 401) }),
    /returned 401/,
  );
  const unsorted = {
    total_count: 2,
    actions_caches: [boundary, old],
  };
  await assert.rejects(
    listCaches({ repository, token, fetchImpl: async () => response(unsorted) }),
    /not sorted/,
  );
  const invalidDate = {
    total_count: 1,
    actions_caches: [{ id: 9, last_accessed_at: "2026-02-30T00:00:00Z" }],
  };
  await assert.rejects(
    listCaches({ repository, token, fetchImpl: async () => response(invalidDate) }),
    /valid instant/,
  );
});

test("pins every third-party workflow action and scopes cleanup to this repository", async () => {
  for (const file of ["ci.yaml", "actions-cache-24h.yaml"]) {
    const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    const references = [...workflow.matchAll(/^\s*-\s+uses:\s+(\S+)/gm)].map(([, value]) => value);
    assert(references.length > 0);
    for (const reference of references) assert.match(reference, /@[0-9a-f]{40}$/);
  }
  const cleanup = await readFile(new URL("../.github/workflows/actions-cache-24h.yaml", import.meta.url), "utf8");
  assert.match(cleanup, /github\.repository == 'selamy-labs\/eve-agent-appliance'/);
  assert.match(cleanup, /cron: "29 \* \* \* \*"/);
  const ci = await readFile(new URL("../.github/workflows/ci.yaml", import.meta.url), "utf8");
  assert.match(ci, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(ci, /runs-on: speedforge/);
  assert.doesNotMatch(ci, /pull_request_target/);
});
