# Eve Agent Appliance

Build-time contracts for declarative Eve agents. This repository contains the
versioned `EveAgentAppliance` schema, the `selamy.exec.v1` grammar, Bazel rules
that bind manifests to explicit targets, deterministic artifact generators,
and a conformance suite.

It is not a runtime service. Agent repositories own their manifests, binaries,
images, and deployment topology.

## Use

```starlark
bazel_dep(name = "eve_agent_appliance", version = "0.1.0")
bazel_dep(name = "platforms", version = "1.0.0")
```

```starlark
load(
    "@eve_agent_appliance//appliance:defs.bzl",
    "agent_appliance",
    "appliance_oci_image",
    "capability_digest_evidence",
    "cronjob_binding",
    "deployment_binding",
    "exec_binding",
    "in_process_binding",
    "job_binding",
    "sidecar_binding",
)

platform(
    name = "linux_amd64",
    constraint_values = [
        "@platforms//cpu:x86_64",
        "@platforms//os:linux",
    ],
)

in_process_binding(
    name = "eve_binding",
    logical_name = "eve",
    target = ":eve_runtime",
    target_platform = ":linux_amd64",
)

exec_binding(
    name = "price_normalizer_binding",
    logical_name = "price-normalizer",
    target = "//capabilities/price-normalizer",
    target_platform = ":linux_amd64",
)

agent_appliance(
    name = "appliance",
    agent_name = "nova",
    architecture = "amd64",
    manifest = "appliance/appliance.yaml",
    bindings = {
        "eve": ":eve_binding",
        "price-normalizer": ":price_normalizer_binding",
    },
    os = "linux",
)

appliance_oci_image(
    name = "image",
    appliance = ":appliance",
    architecture = "amd64",
    base = ":base_image",
    os = "linux",
    runtime_layer = ":appliance_runtime_layer",
    target_platform = ":linux_amd64",
    tars = [":application_layer"],
)

capability_digest_evidence(
    name = "capability_digest",
    image = ":image",
)
```

The rule emits canonical manifest JSON, a trusted binding manifest, and a
sanitized model-visible catalog. Typed binding wrappers require a real Bazel
executable and collect its default runfiles, data runfiles, and repository
mapping, including logical symlink and root-symlink entries. All six closed
invocation shapes have typed wrappers: `in_process`, `exec`, `sidecar`, `job`,
`cronjob`, and `deployment`. Each wrapper transitions its executable closure to
the required target platform. Image analysis rejects a target platform whose
OS or CPU constraints disagree with the OCI metadata.

`:appliance_runtime_layer` maps the complete closure to the fixed
in-image paths. `appliance_oci_image` always adds this layer last, and
`:capability_digest` derives the digest from the resulting OCI layout only after
verifying every declared runtime file's bytes, mode, and ownership. Digest
evidence remains outside every image layer.

The exported JSON schema encodes every local mode, protocol, required-field,
forbidden-field, authority-floor, health, endpoint, and schema-reference rule.
The generator is the complete conformance authority for cross-entry rules that
JSON Schema cannot express locally: agent identity, entrypoint resolution,
pairwise uniqueness, manifest-to-binding correspondence, and typed Bazel
binding-mode identity. Both paths are exercised against the same checked-in
acceptance corpus.

## Development

```bash
bazel test //...
bazel build //...
(cd test/consumer && bazel test //... && bazel build //... && bazel run //:consumer_image_load)
```

GitHub Actions cache entries last accessed more than 24 hours ago are removed
by a source-controlled hourly policy. GitHub exposes no per-cache-ID read, so
the cleanup records its two matching inventory passes and the unavoidable
non-atomic list/delete interval instead of claiming atomic deletion. No
Dockerfile is used or provided.
