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
```

```starlark
load(
    "@eve_agent_appliance//appliance:defs.bzl",
    "agent_appliance",
    "capability_digest_evidence",
)

agent_appliance(
    name = "appliance",
    agent_name = "nova",
    manifest = "appliance/appliance.yaml",
    bindings = {
        "eve": ":eve_runtime",
        "price-normalizer": "//capabilities/price-normalizer",
    },
)

capability_digest_evidence(
    name = "capability_digest",
    appliance = ":appliance",
    image_digest = ":image.digest",
)
```

The rule emits canonical manifest JSON, a trusted binding manifest, and a
sanitized model-visible catalog. Package `:appliance_runtime_artifacts` (or
the individual `:appliance_catalog` and `:appliance_binding` targets), never
the aggregate rule or `:appliance_manifest`. The separate
`:capability_digest` output is generated after the image digest exists and must
remain outside every image layer. Validation fails closed on unknown fields,
closed-enum violations, invalid mode/protocol combinations, undeclared or
unused bindings, and authority-bearing values disguised as logical names.

## Development

```bash
bazel test //...
bazel build //...
```

GitHub Actions cache entries last accessed more than 24 hours ago are removed
by a source-controlled hourly policy. No Dockerfile is used or provided.
