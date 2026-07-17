# Contract boundary

`EveAgentAppliance v1alpha1` is a build-time contract. It provides no runtime
service, credentials, deployment controller, shell, repository authority, or
policy decision identity.

The agent repository owns the source manifest and binds every logical name to
one explicit Bazel target. The shared rule performs analysis-time shape checks,
then a hermetic action parses and validates the YAML content. It emits:

- canonical manifest JSON and its SHA-256 identity;
- a trusted binding manifest containing labels and fixed image paths; and
- a sanitized catalog that can be shown to Eve without exposing labels, paths,
  secret references, RBAC names, or an image digest.

The output byte cap is fixed at 65,536 bytes for each stream in v1alpha1. It is
not manifest-controlled. The binding manifest gives every declared capability a
stable fixed image path, but only `exec` capabilities may be spawned by the
typed exec runner. In-process entrypoint bindings prove build closure and are
not process-execution authority.

The six invocation modes are closed. Adding a mode, changing the protocol
matrix, tightening a previously accepted manifest, or removing an enum member
requires a schema-version change. Additive optional fields and enum members may
ship in a compatible tagged module release.

Capability-to-image-digest evidence is intentionally outside this module's
in-image outputs. The consuming agent creates that evidence after `rules_oci`
produces the candidate digest; it must never add the resulting evidence file to
an image layer.
