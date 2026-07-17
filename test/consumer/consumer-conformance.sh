#!/usr/bin/env bash
set -euo pipefail

root="${TEST_SRCDIR}/_main"
if command -v sha256sum >/dev/null 2>&1; then
  hash() { sha256sum "$1" | cut -d' ' -f1; }
else
  hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

for artifact in binding catalog manifest; do
  actual="$(hash "${root}/consumer_appliance.${artifact}.json")"
  expected="$(cat "${root}/golden/${artifact}.sha256")"
  [[ "${actual}" == "${expected}" ]]
done

evidence="$(cat "${root}/consumer_digest_evidence.json")"
[[ "${evidence}" =~ \"imageDigest\":\"sha256:[0-9a-f]{64}\" ]]
[[ "${evidence}" == *'consumer.echo-tool.v1'* ]]
[[ "${evidence}" != *'/opt/selamy/'* ]]
