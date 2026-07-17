"""Bazel bindings for the EveAgentAppliance v1alpha1 contract."""

load("@rules_pkg//pkg:providers.bzl", "PackageFilegroupInfo", "PackageFilesInfo")
load("@rules_pkg//pkg:tar.bzl", "pkg_tar")
load("@rules_oci//oci:defs.bzl", "oci_image")

ApplianceBindingInfo = provider(
    doc = "Typed executable binding and its complete runtime closure.",
    fields = {
        "executable": "The target's declared executable.",
        "image_files": "Destination-to-source mapping for the OCI layer.",
        "logical_name": "Logical manifest binding name.",
        "mode": "Permitted manifest invocation mode.",
        "runtime_files": "Executable, default/data runfiles, and repo mapping.",
        "target_label": "Canonical label of the bound executable target.",
    },
)

ApplianceInfo = provider(
    doc = "Generated appliance artifacts and bound runtime targets.",
    fields = {
        "binding": "Trusted runtime binding manifest.",
        "canonical_manifest": "Canonical JSON form of the source manifest.",
        "catalog": "Sanitized model-visible capability catalog.",
        "image_files": "Destination-to-source mapping required in the OCI image.",
        "runtime_files": "Complete files bound to logical capability names.",
    },
)

_ApplianceImageInfo = provider(
    doc = "OCI layout built with the appliance runtime layer as its final layer.",
    fields = {
        "appliance": "The ApplianceInfo packaged by this image.",
        "appliance_label": "Canonical label of the packaged appliance.",
        "layout": "The rules_oci layout tree artifact.",
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


def _runfile_destination(logical_name, file):
    short_path = file.short_path
    if short_path.startswith("../"):
        relative = short_path[3:]
    else:
        relative = "_main/" + short_path
    return "opt/selamy/bin/%s.runfiles/%s" % (logical_name, relative)


def _package_files(dest_src_map, mode):
    return PackageFilesInfo(
        attributes = {
            "group": "10001",
            "mode": mode,
            "user": "10001",
        },
        dest_src_map = dest_src_map,
    )


def _appliance_binding_impl(ctx):
    logical_name = ctx.attr.logical_name
    if not _is_logical_name(logical_name):
        fail("invalid logical binding name: %s" % logical_name)

    default_info = ctx.attr.target[DefaultInfo]
    files_to_run = default_info.files_to_run
    executable = files_to_run.executable
    if executable == None:
        fail("%s binding %s must target a Bazel executable" % (ctx.attr.mode, logical_name))

    transitive_runfiles = [
        default_info.default_runfiles.files,
        default_info.data_runfiles.files,
    ]
    repo_mapping = files_to_run.repo_mapping_manifest
    direct_runtime_files = [executable]
    if repo_mapping != None:
        direct_runtime_files.append(repo_mapping)
    runtime_files = depset(direct_runtime_files, transitive = transitive_runfiles)

    executable_path = "opt/selamy/bin/%s" % logical_name
    image_files = {executable_path: executable}
    runfile_paths = {}
    for file in depset(transitive = transitive_runfiles).to_list():
        if file.path == executable.path:
            continue
        destination = _runfile_destination(logical_name, file)
        if destination in image_files or destination in runfile_paths:
            fail("binding %s maps multiple runtime files to %s" % (logical_name, destination))
        runfile_paths[destination] = file
        image_files[destination] = file
    if repo_mapping != None:
        repo_mapping_path = executable_path + ".repo_mapping"
        image_files[repo_mapping_path] = repo_mapping
        runfile_paths[repo_mapping_path] = repo_mapping

    package_files = [
        (_package_files({executable_path: executable}, "0555"), ctx.label),
    ]
    if runfile_paths:
        package_files.append((_package_files(runfile_paths, "0444"), ctx.label))

    return [
        DefaultInfo(files = runtime_files),
        OutputGroupInfo(appliance_binding_runtime = runtime_files),
        PackageFilegroupInfo(
            pkg_dirs = [],
            pkg_files = package_files,
            pkg_symlinks = [],
        ),
        ApplianceBindingInfo(
            executable = executable,
            image_files = image_files,
            logical_name = logical_name,
            mode = ctx.attr.mode,
            runtime_files = runtime_files,
            target_label = str(ctx.attr.target.label),
        ),
    ]


_appliance_binding = rule(
    implementation = _appliance_binding_impl,
    attrs = {
        "logical_name": attr.string(mandatory = True),
        "mode": attr.string(mandatory = True, values = ["exec", "in_process"]),
        "target": attr.label(mandatory = True),
    },
)


def exec_binding(name, logical_name, target, visibility = None, tags = None):
    """Binds one fixed executable and its runfiles to an exec capability."""
    _appliance_binding(
        name = name,
        logical_name = logical_name,
        mode = "exec",
        target = target,
        tags = tags,
        visibility = visibility,
    )


def in_process_binding(name, logical_name, target, visibility = None, tags = None):
    """Binds the executable closure hosting an in-process Eve capability."""
    _appliance_binding(
        name = name,
        logical_name = logical_name,
        mode = "in_process",
        target = target,
        tags = tags,
        visibility = visibility,
    )


def _agent_appliance_impl(ctx):
    if len(ctx.attr.binding_names) != len(ctx.attr.bindings):
        fail("binding_names and bindings must have identical lengths")
    runtime_transitive = []
    binding_labels = []
    binding_modes = []
    executables = []
    image_files = {}
    package_files = []
    seen_labels = {}
    for index, target in enumerate(ctx.attr.bindings):
        logical_name = ctx.attr.binding_names[index]
        if not _is_logical_name(logical_name):
            fail("invalid logical binding name: %s" % logical_name)
        binding_info = target[ApplianceBindingInfo]
        if binding_info.logical_name != logical_name:
            fail("binding map key %s does not match wrapper logical name %s" % (logical_name, binding_info.logical_name))
        canonical_label = binding_info.target_label
        if canonical_label in seen_labels:
            fail("bindings %s and %s resolve to the same target %s" % (seen_labels[canonical_label], logical_name, canonical_label))
        seen_labels[canonical_label] = logical_name
        binding_labels.append(canonical_label)
        binding_modes.append(binding_info.mode)
        executables.append(binding_info.executable)
        runtime_transitive.append(binding_info.runtime_files)
        package_files.extend(target[PackageFilegroupInfo].pkg_files)
        for destination, source in binding_info.image_files.items():
            if destination in image_files:
                fail("multiple bindings package %s" % destination)
            image_files[destination] = source

    catalog = ctx.actions.declare_file(ctx.label.name + ".catalog.json")
    binding = ctx.actions.declare_file(ctx.label.name + ".binding.json")
    canonical_manifest = ctx.actions.declare_file(ctx.label.name + ".manifest.json")

    args = ctx.actions.args()
    args.add("--agent-name", ctx.attr.agent_name)
    args.add("--manifest", ctx.file.manifest)
    args.add("--catalog", catalog)
    args.add("--binding-manifest", binding)
    args.add("--canonical-manifest", canonical_manifest)
    for index, executable in enumerate(executables):
        args.add("--logical-name", ctx.attr.binding_names[index])
        args.add("--binary", executable)
        args.add("--binding-mode", binding_modes[index])
        args.add("--label", binding_labels[index])

    runtime_files = depset(transitive = runtime_transitive)
    ctx.actions.run(
        arguments = [args],
        env = {"BAZEL_BINDIR": "."},
        executable = ctx.executable._generator,
        inputs = depset([ctx.file.manifest], transitive = runtime_transitive),
        mnemonic = "EveAgentAppliance",
        outputs = [catalog, binding, canonical_manifest],
        progress_message = "Validating and generating %{label}",
        tools = [ctx.attr._generator[DefaultInfo].files_to_run],
    )

    metadata_image_files = {
        "app/appliance/binding.json": binding,
        "app/appliance/catalog.json": catalog,
    }
    for destination, source in metadata_image_files.items():
        if destination in image_files:
            fail("runtime binding collides with appliance metadata at %s" % destination)
        image_files[destination] = source
    package_files.append((_package_files(metadata_image_files, "0444"), ctx.label))

    return [
        DefaultInfo(files = depset()),
        OutputGroupInfo(
            appliance_binding = depset([binding]),
            appliance_catalog = depset([catalog]),
            appliance_manifest = depset([canonical_manifest]),
            appliance_runtime_closure = depset([catalog, binding], transitive = runtime_transitive),
        ),
        PackageFilegroupInfo(
            pkg_dirs = [],
            pkg_files = package_files,
            pkg_symlinks = [],
        ),
        ApplianceInfo(
            binding = binding,
            canonical_manifest = canonical_manifest,
            catalog = catalog,
            image_files = image_files,
            runtime_files = runtime_files,
        ),
    ]


_agent_appliance = rule(
    implementation = _agent_appliance_impl,
    attrs = {
        "agent_name": attr.string(mandatory = True),
        "manifest": attr.label(allow_single_file = [".yaml", ".yml"], mandatory = True),
        "binding_names": attr.string_list(mandatory = True),
        "bindings": attr.label_list(mandatory = True, providers = [ApplianceBindingInfo]),
        "_generator": attr.label(
            cfg = "exec",
            default = Label("//:appliance_generator"),
            executable = True,
        ),
    },
)


def _appliance_runtime_layout_impl(ctx):
    appliance = ctx.attr.appliance[ApplianceInfo]
    package = ctx.attr.appliance[PackageFilegroupInfo]
    closure = depset(
        [appliance.catalog, appliance.binding],
        transitive = [appliance.runtime_files],
    )
    return [
        DefaultInfo(files = closure),
        PackageFilegroupInfo(
            pkg_dirs = package.pkg_dirs,
            pkg_files = package.pkg_files,
            pkg_symlinks = package.pkg_symlinks,
        ),
    ]


_appliance_runtime_layout = rule(
    implementation = _appliance_runtime_layout_impl,
    attrs = {
        "appliance": attr.label(
            mandatory = True,
            providers = [ApplianceInfo, PackageFilegroupInfo],
        ),
    },
)


def agent_appliance(name, agent_name, manifest, bindings, visibility = None, tags = None):
    """Validates a manifest, binds typed targets, and emits a runtime layer."""
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
    for output_group in ["binding", "catalog", "manifest", "runtime_closure"]:
        native.filegroup(
            name = name + "_" + output_group,
            srcs = [":" + name],
            output_group = "appliance_" + output_group,
            tags = tags,
            visibility = visibility,
        )
    layout_name = name + "_runtime_layout"
    _appliance_runtime_layout(
        name = layout_name,
        appliance = ":" + name,
        tags = tags,
        visibility = ["//visibility:private"],
    )
    pkg_tar(
        name = name + "_runtime_layer",
        srcs = [":" + layout_name],
        owner = "10001.10001",
        portable_mtime = True,
        tags = tags,
        visibility = visibility,
    )


def _appliance_image_impl(ctx):
    layout_files = ctx.attr.layout[DefaultInfo].files.to_list()
    if len(layout_files) != 1 or not layout_files[0].is_directory:
        fail("layout must be one rules_oci OCI-layout tree artifact")
    return [
        DefaultInfo(files = depset(layout_files)),
        _ApplianceImageInfo(
            appliance = ctx.attr.appliance[ApplianceInfo],
            appliance_label = str(ctx.attr.appliance.label),
            layout = layout_files[0],
        ),
    ]


_appliance_image = rule(
    implementation = _appliance_image_impl,
    attrs = {
        "appliance": attr.label(mandatory = True, providers = [ApplianceInfo]),
        "layout": attr.label(mandatory = True),
    },
)


def appliance_oci_image(
        name,
        appliance,
        runtime_layer,
        architecture = None,
        base = None,
        os = None,
        tars = [],
        visibility = None,
        tags = None):
    """Builds an OCI image whose final layer is the declared appliance closure."""
    layout_name = name + "_oci_layout"
    image_args = {
        "name": layout_name,
        "tars": tars + [runtime_layer],
        "tags": tags,
        "visibility": ["//visibility:private"],
    }
    if base != None:
        image_args["base"] = base
    else:
        if os == None or architecture == None:
            fail("scratch appliance images require os and architecture")
        image_args["os"] = os
        image_args["architecture"] = architecture
    oci_image(**image_args)
    _appliance_image(
        name = name,
        appliance = appliance,
        layout = ":" + layout_name,
        tags = tags,
        visibility = visibility,
    )


def _capability_digest_evidence_impl(ctx):
    image = ctx.attr.image[_ApplianceImageInfo]
    appliance = image.appliance
    evidence = ctx.actions.declare_file(ctx.label.name + ".json")
    args = ctx.actions.args()
    args.add("--binding-manifest", appliance.binding)
    args.add("--oci-layout", image.layout.path)
    args.add("--output", evidence)
    image_sources = []
    for destination in sorted(appliance.image_files.keys()):
        source = appliance.image_files[destination]
        args.add("--image-path", "/" + destination)
        args.add("--source-file", source)
        image_sources.append(source)
    ctx.actions.run(
        arguments = [args],
        env = {"BAZEL_BINDIR": "."},
        executable = ctx.executable._generator,
        inputs = depset([appliance.binding, image.layout] + image_sources),
        mnemonic = "CapabilityDigestEvidence",
        outputs = [evidence],
        progress_message = "Verifying capability closure in OCI image for %{label}",
        tools = [ctx.attr._generator[DefaultInfo].files_to_run],
    )
    return [DefaultInfo(files = depset([evidence]))]


capability_digest_evidence = rule(
    implementation = _capability_digest_evidence_impl,
    attrs = {
        "image": attr.label(mandatory = True, providers = [_ApplianceImageInfo]),
        "_generator": attr.label(
            cfg = "exec",
            default = Label("//:capability_digest_generator"),
            executable = True,
        ),
    },
)
