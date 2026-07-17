#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API_VERSION = "2022-11-28";
const PAGE_SIZE = 100;
const RETENTION_MS = 24 * 60 * 60 * 1_000;

function requireRepository(repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new TypeError("repository must have owner/name form");
  }
  return repository;
}

function instant(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) {
    throw new TypeError(`${field} must be an ISO 8601 UTC instant`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${field} must be a valid instant`);
  return milliseconds;
}

async function request(fetchImpl, url, token, init = {}) {
  return fetchImpl(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
}

async function bodySnippet(response) {
  return (await response.text()).slice(0, 300).replaceAll(/\s+/g, " ");
}

export async function listCaches({ repository, token, fetchImpl = fetch }) {
  requireRepository(repository);
  if (!token) throw new TypeError("token must be non-empty");
  const caches = [];
  const seen = new Set();
  let expectedTotal;
  let previousInstant = -Infinity;
  for (let page = 1; page <= 10_000; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repository}/actions/caches`);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "last_accessed_at");
    url.searchParams.set("direction", "asc");
    const response = await request(fetchImpl, url, token);
    if (response.status !== 200) {
      throw new Error(`cache inventory page ${page} returned ${response.status}: ${await bodySnippet(response)}`);
    }
    const payload = await response.json();
    if (!Number.isSafeInteger(payload?.total_count) || !Array.isArray(payload?.actions_caches)) {
      throw new TypeError(`cache inventory page ${page} is malformed`);
    }
    expectedTotal ??= payload.total_count;
    if (payload.total_count !== expectedTotal || payload.actions_caches.length > PAGE_SIZE) {
      throw new Error("cache inventory changed or exceeded the requested page size");
    }
    for (const cache of payload.actions_caches) {
      if (!Number.isSafeInteger(cache?.id) || cache.id <= 0 || seen.has(cache.id)) {
        throw new TypeError("cache inventory contains an invalid or duplicate ID");
      }
      const accessed = instant(cache.last_accessed_at, "last_accessed_at");
      if (accessed < previousInstant) throw new Error("cache inventory is not sorted by last_accessed_at");
      previousInstant = accessed;
      seen.add(cache.id);
      caches.push({ id: cache.id, lastAccessedAt: cache.last_accessed_at });
    }
    if (payload.actions_caches.length < PAGE_SIZE) {
      if (caches.length !== expectedTotal) throw new Error("cache inventory count changed during pagination");
      return caches;
    }
  }
  throw new Error("cache inventory exceeded safety page limit");
}

function sameInventory(first, second) {
  if (first.length !== second.length) return false;
  const expected = new Map(first.map((cache) => [cache.id, cache.lastAccessedAt]));
  return second.every((cache) => expected.get(cache.id) === cache.lastAccessedAt);
}

export async function enforceCacheLifetime({
  repository,
  token,
  now = new Date(),
  dryRun = false,
  fetchImpl = fetch,
}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date");
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
  const first = await listCaches({ repository, token, fetchImpl });
  const confirmed = await listCaches({ repository, token, fetchImpl });
  if (!sameInventory(first, confirmed)) throw new Error("cache inventory changed between confirmation passes");
  const eligibleIds = confirmed
    .filter((cache) => instant(cache.lastAccessedAt, "last_accessed_at") < instant(cutoff, "cutoff"))
    .map(({ id }) => id);
  const deletedIds = [];
  if (!dryRun) {
    for (const id of eligibleIds) {
      const url = `https://api.github.com/repos/${repository}/actions/caches/${id}`;
      const response = await request(fetchImpl, url, token, { method: "DELETE" });
      if (response.status !== 204) {
        throw new Error(`cache ${id} delete returned ${response.status}: ${await bodySnippet(response)}`);
      }
      deletedIds.push(id);
    }
  }
  return { cutoff, dryRun, observed: confirmed.length, eligibleIds, deletedIds };
}

export function renderSummary(result) {
  return [
    "## 24-hour Actions cache enforcement",
    "",
    `- Strict cutoff: \`${result.cutoff}\``,
    `- Mode: ${result.dryRun ? "dry-run" : "delete"}`,
    `- Observed: ${result.observed}`,
    `- Eligible IDs: ${result.eligibleIds.join(", ") || "none"}`,
    `- Deleted IDs: ${result.deletedIds.join(", ") || "none"}`,
    "",
  ].join("\n");
}

async function main() {
  const dryRun = process.env.DRY_RUN === "true";
  if (process.env.DRY_RUN && !["true", "false"].includes(process.env.DRY_RUN)) {
    throw new TypeError("DRY_RUN must be true or false");
  }
  const result = await enforceCacheLifetime({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    dryRun,
  });
  const summary = renderSummary(result);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
