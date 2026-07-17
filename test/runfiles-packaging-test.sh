#!/bin/sh
set -eu

archive="${TEST_SRCDIR}/_main/fixture_runfiles_exec_tar.tar"
empty_archive="${TEST_SRCDIR}/_main/fixture_empty_runfiles_tar.tar"
listing="$(tar -tf "${archive}")"
empty_listing="$(tar -tf "${empty_archive}")"

for path in \
  opt/selamy/bin/runfiles-exec \
  opt/selamy/bin/runfiles-exec.runfiles/_main/mapped/default-tool \
  opt/selamy/bin/runfiles-exec.runfiles/_main/mapped/data-tool \
  opt/selamy/bin/runfiles-exec.runfiles/root/default-data \
  opt/selamy/bin/runfiles-exec.runfiles/root/data-data \
  opt/selamy/bin/runfiles-exec.runfiles/_repo_mapping
do
  printf '%s\n' "${listing}" | grep -Fxq "${path}"
done

for path in \
  opt/selamy/bin/runfiles-empty.runfiles/_main/test/__init__.py \
  opt/selamy/bin/runfiles-empty.runfiles/_main/test/fixtures/__init__.py
do
  printf '%s\n' "${empty_listing}" | grep -Fxq "${path}"
  size="$(tar -xOf "${empty_archive}" "${path}" | wc -c | tr -d '[:space:]')"
  test "${size}" = 0
done

details="$(tar -tvf "${archive}")"
for path in \
  opt/selamy/bin/runfiles-exec \
  opt/selamy/bin/runfiles-exec.runfiles/_main/mapped/default-tool \
  opt/selamy/bin/runfiles-exec.runfiles/_main/mapped/data-tool
do
  printf '%s\n' "${details}" | grep -E "^-r-xr-xr-x .*10001.*10001.* ${path}$" >/dev/null
done
