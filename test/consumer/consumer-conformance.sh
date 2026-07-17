#!/bin/sh
set -eu

root="${TEST_SRCDIR}/_main"
if command -v sha256sum >/dev/null 2>&1; then
  hash() { sha256sum "$1" | cut -d' ' -f1; }
else
  hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

for artifact in binding catalog manifest; do
  actual="$(hash "${root}/consumer_appliance.${artifact}.json")"
  expected="$(cat "${root}/golden/${artifact}.sha256")"
  test "${actual}" = "${expected}"
done

evidence="$(cat "${root}/consumer_digest_evidence.json")"
printf '%s' "${evidence}" | grep -Eq '"imageDigest":"sha256:[0-9a-f]{64}"'
printf '%s' "${evidence}" | grep -Fq 'consumer.echo-tool.v1'
if printf '%s' "${evidence}" | grep -Fq '/opt/selamy/'; then
  exit 1
fi
