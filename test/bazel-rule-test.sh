#!/usr/bin/env bash
set -euo pipefail

root="${TEST_SRCDIR}/_main"
for artifact in \
  example_appliance.catalog.json \
  example_appliance.binding.json \
  example_appliance.manifest.json; do
  test -s "${root}/${artifact}"
done

catalog="$(cat "${root}/example_appliance.catalog.json")"
binding="$(cat "${root}/example_appliance.binding.json")"
evidence="$(cat "${root}/example_capability_digest.json")"

[[ "${catalog}" == *'nova.price-normalizer.v1'* ]]
[[ "${catalog}" != *'/opt/selamy/'* ]]
[[ "${catalog}" != *'//:fixture_price_normalizer'* ]]
[[ "${binding}" == *'/opt/selamy/bin/price-normalizer'* ]]
[[ "${binding}" == *'//:fixture_price_normalizer'* ]]
[[ "${binding}" != *'imageDigest'* ]]
[[ "${evidence}" == *'nova.price-normalizer.v1'* ]]
[[ "${evidence}" =~ \"imageDigest\":\"sha256:[0-9a-f]{64}\" ]]
[[ "${evidence}" != *'/opt/selamy/'* ]]
