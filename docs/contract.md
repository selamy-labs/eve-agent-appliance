# Contract boundary

`EveAgentAppliance v1alpha1` is a build-time contract. It provides no runtime
service, credentials, deployment controller, shell, repository authority, or
policy decision identity.

The agent repository owns the source manifest and binds every logical name
through a typed wrapper to one explicit Bazel executable. The wrapper requires
`files_to_run.executable` and closes over default runfiles, data runfiles, and
the repository-mapping manifest. The shared rule performs analysis-time shape
checks, then a hermetic action parses and validates the YAML content. It emits:

- canonical manifest JSON and its SHA-256 identity;
- a trusted binding manifest containing labels and fixed image paths; and
- a sanitized catalog that can be shown to Eve without exposing labels, paths,
  secret references, RBAC names, or an image digest; and
- a deterministic runtime layer mapping metadata, executables, and runfiles to
  their declared paths with fixed modes and uid/gid `10001:10001`.

The output byte cap is fixed at 65,536 bytes for each stream in v1alpha1. It is
not manifest-controlled. The binding manifest gives every declared capability a
stable fixed image path, but only `exec` capabilities may be spawned by the
typed exec runner. In-process entrypoint bindings prove build closure and are
not process-execution authority.

The public schema enforces all local field and mode constraints. The generator
also enforces agent identity, entrypoint resolution, uniqueness, binding-map
closure, and typed binding-mode agreement because those cross-entry and Bazel
relationships cannot be expressed completely by the standalone JSON schema.
Schema and generator are tested against one acceptance corpus.

The six invocation modes are closed. For `deployment`, both `grpc` and `rest`
use the required `host:port` endpoint; only `sidecar` requires a `127.0.0.0/8`
loopback host. Adding a mode, changing the protocol
matrix, tightening a previously accepted manifest, or removing an enum member
requires a schema-version change. Additive optional fields and enum members may
ship in a compatible tagged module release.

Capability-to-image-digest evidence is intentionally outside this module's
in-image outputs. The evidence rule accepts only the typed appliance image
produced by `appliance_oci_image`, derives its digest from the OCI index, verifies
all manifest and layer digests, and compares every declared runtime path with
its Bazel source before emitting evidence. It must never add the resulting
evidence file to an image layer.
