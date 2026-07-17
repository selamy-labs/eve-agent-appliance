"""Bazel bindings for the EveAgentAppliance v1alpha1 contract."""

ApplianceInfo = provider(
    doc = "Generated appliance artifacts and bound runtime targets.",
    fields = {
        "binding": "Trusted runtime binding manifest.",
        "canonical_manifest": "Canonical JSON form of the source manifest.",
        "catalog": "Sanitized model-visible capability catalog.",
        "runtime_files": "Files bound to logical capability names.",
    },
)

_LOGICAL_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-"


def _is_logical_name(value):
    if len(value) < 2 or len(value) > 63:
        return False
    if value[0] not in "abcdefghijklmnopqrstuvwxyz":
        return False
    if value[-1] not in "abcdefghijklmnopqrstuvwxyz0123456789":
        return False
    return all([character in _LOGICAL_CHARS for character in value.elems()])


def _agent_appliance_impl(ctx):
    if len(ctx.attr.binding_names) != len(ctx.attr.bindings):
        fail("binding_names and bindings must have identical lengths")
    runtime_files = []
    binding_labels = []
    seen_labels = {}
    for index, target in enumerate(ctx.attr.bindings):
        logical_name = ctx.attr.binding_names[index]
        if not _is_logical_name(logical_name):
            fail("invalid logical binding name: %s" % logical_name)
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("binding %s must produce exactly one file, got %d" % (logical_name, len(files)))
        canonical_label = str(target.label)
        if canonical_label in seen_labels:
            fail("bindings %s and %s resolve to the same target %s" % (seen_labels[canonical_label], logical_name, canonical_label))
        seen_labels[canonical_label] = logical_name
        runtime_files.append(files[0])
        binding_labels.append(canonical_label)

    catalog = ctx.actions.declare_file(ctx.label.name + ".catalog.json")
    binding = ctx.actions.declare_file(ctx.label.name + ".binding.json")
    canonical_manifest = ctx.actions.declare_file(ctx.label.name + ".manifest.json")

    args = ctx.actions.args()
    args.add("--agent-name", ctx.attr.agent_name)
    args.add("--manifest", ctx.file.manifest)
    args.add("--catalog", catalog)
    args.add("--binding-manifest", binding)
    args.add("--canonical-manifest", canonical_manifest)
    for index, runtime_file in enumerate(runtime_files):
        args.add("--logical-name", ctx.attr.binding_names[index])
        args.add("--binary", runtime_file)
        args.add("--label", binding_labels[index])

    ctx.actions.run(
        arguments = [args],
        env = {"BAZEL_BINDIR": "."},
        executable = ctx.executable._generator,
        inputs = depset([ctx.file.manifest] + runtime_files),
        mnemonic = "EveAgentAppliance",
        outputs = [catalog, binding, canonical_manifest],
        progress_message = "Validating and generating %{label}",
        tools = [ctx.attr._generator[DefaultInfo].files_to_run],
    )

    outputs = depset([catalog, binding, canonical_manifest])
    return [
        DefaultInfo(files = outputs),
        ApplianceInfo(
            binding = binding,
            canonical_manifest = canonical_manifest,
            catalog = catalog,
            runtime_files = depset(runtime_files),
        ),
    ]


_agent_appliance = rule(
    implementation = _agent_appliance_impl,
    attrs = {
        "agent_name": attr.string(mandatory = True),
        "manifest": attr.label(allow_single_file = [".yaml", ".yml"], mandatory = True),
        "binding_names": attr.string_list(mandatory = True),
        "bindings": attr.label_list(allow_files = True, mandatory = True),
        "_generator": attr.label(
            cfg = "exec",
            default = Label("//:appliance_generator"),
            executable = True,
        ),
    },
)


def agent_appliance(name, agent_name, manifest, bindings, visibility = None, tags = None):
    """Validates a manifest and binds every declared capability to a target.

    Args:
      name: Target name.
      agent_name: Expected DNS-1123 agent identity.
      manifest: EveAgentAppliance YAML manifest.
      bindings: Dict from logical names to single-file Bazel targets.
      visibility: Optional target visibility.
      tags: Optional Bazel tags.
    """
    if not bindings:
        fail("bindings must be non-empty")
    names = sorted(bindings.keys())
    _agent_appliance(
        name = name,
        agent_name = agent_name,
        manifest = manifest,
        binding_names = names,
        bindings = [bindings[logical_name] for logical_name in names],
        tags = tags,
        visibility = visibility,
    )
