"""Bazel bindings for the EveAgentAppliance v1alpha1 contract."""

load("@rules_pkg//pkg:providers.bzl", "PackageFilegroupInfo", "PackageFilesInfo")
load("@rules_pkg//pkg:tar.bzl", "pkg_tar")
load("@rules_oci//oci:defs.bzl", "oci_image")

ApplianceBindingInfo = provider(
    doc = "Typed executable binding and its complete runtime closure.",
    fields = {
        "executable": "The target's declared executable.",
        "image_files": "Destination-to-source mapping for the OCI layer.",
        "image_modes": "Destination-to-expected-mode mapping for the OCI layer.",
        "logical_name": "Logical manifest binding name.",
        "mode": "Permitted manifest invocation mode.",
        "runtime_files": "Executable, default/data runfiles, and repo mapping.",
        "target_label": "Canonical label of the bound executable target.",
        "target_platform": "Canonical label of the target platform used for the executable.",
    },
)

ApplianceInfo = provider(
    doc = "Generated appliance artifacts and bound runtime targets.",
    fields = {
        "architecture": "Declared OCI architecture for the appliance.",
        "binding": "Trusted runtime binding manifest.",
        "canonical_manifest": "Canonical JSON form of the source manifest.",
        "catalog": "Sanitized model-visible capability catalog.",
        "image_files": "Destination-to-source mapping required in the OCI image.",
        "image_modes": "Destination-to-expected-mode mapping required in the OCI image.",
        "os": "Declared OCI operating system for the appliance.",
        "runtime_files": "Complete files bound to logical capability names.",
        "target_platform": "Canonical label of the target platform used by every binding.",
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
_MODES = ["in_process", "exec", "sidecar", "job", "cronjob", "deployment"]
_METADATA_MODE = "0444"
_RUNTIME_MODE = "0555"
_OCI_ARCHITECTURE_CONSTRAINTS = {
    "386": "@platforms//cpu:i386",
    "amd64": "@platforms//cpu:x86_64",
    "arm": "@platforms//cpu:arm",
    "arm64": "@platforms//cpu:arm64",
    "mips64le": "@platforms//cpu:mips64",
    "ppc64le": "@platforms//cpu:ppc64le",
    "riscv64": "@platforms//cpu:riscv64",
    "s390x": "@platforms//cpu:s390x",
    "wasm": "@platforms//cpu:wasm32",
}
_OCI_OS_CONSTRAINTS = {
    "darwin": "@platforms//os:macos",
    "freebsd": "@platforms//os:freebsd",
    "linux": "@platforms//os:linux",
    "netbsd": "@platforms//os:netbsd",
    "openbsd": "@platforms//os:openbsd",
    "windows": "@platforms//os:windows",
}

_PlatformConstraintCheckInfo = provider()


def _is_logical_name(value):
    if len(value) < 2 or len(value) > 63:
        return False
    if value[0] not in "abcdefghijklmnopqrstuvwxyz":
        return False
    if value[-1] not in "abcdefghijklmnopqrstuvwxyz0123456789":
        return False
    return all([character in _LOGICAL_CHARS for character in value.elems()])


def _runfile_relative_path(file):
    short_path = file.short_path
    if short_path.startswith("../"):
        return short_path[3:]
    return "_main/" + short_path


def _runfile_destination(logical_name, relative):
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


def _add_image_file(image_files, image_modes, destination, source, mode, owner):
    if destination in image_files:
        if image_files[destination].path != source.path or image_modes[destination] != mode:
            fail("%s maps conflicting runtime files to %s" % (owner, destination))
        return False
    image_files[destination] = source
    image_modes[destination] = mode
    return True


def _target_platform_transition_impl(_settings, attr):
    return {"//command_line_option:platforms": str(attr.target_platform)}


_target_platform_transition = transition(
    implementation = _target_platform_transition_impl,
    inputs = [],
    outputs = ["//command_line_option:platforms"],
)


def _platform_constraint_check_impl(ctx):
    checks = [
        (ctx.attr.os_constraint, "operating system", ctx.attr.os),
        (ctx.attr.architecture_constraint, "architecture", ctx.attr.architecture),
    ]
    for target, dimension, value in checks:
        if not ctx.target_platform_has_constraint(target[platform_common.ConstraintValueInfo]):
            fail("target platform %s does not satisfy OCI %s %s" % (ctx.attr.target_platform_label, dimension, value))
    return [_PlatformConstraintCheckInfo()]


_platform_constraint_check = rule(
    implementation = _platform_constraint_check_impl,
    attrs = {
        "architecture": attr.string(mandatory = True),
        "architecture_constraint": attr.label(mandatory = True, providers = [platform_common.ConstraintValueInfo]),
        "os": attr.string(mandatory = True),
        "os_constraint": attr.label(mandatory = True, providers = [platform_common.ConstraintValueInfo]),
        "target_platform_label": attr.string(mandatory = True),
    },
)


def _oci_constraint(mapping, value, dimension):
    constraint = mapping.get(value)
    if constraint == None:
        fail("unsupported OCI %s for Bazel platform validation: %s" % (dimension, value))
    return constraint


def _appliance_binding_impl(ctx):
    logical_name = ctx.attr.logical_name
    if not _is_logical_name(logical_name):
        fail("invalid logical binding name: %s" % logical_name)

    transitioned_targets = ctx.attr.target
    if len(transitioned_targets) != 1:
        fail("binding %s target platform transition must produce exactly one target" % logical_name)
    target = transitioned_targets[0]
    default_info = target[DefaultInfo]
    files_to_run = default_info.files_to_run
    executable = files_to_run.executable
    if executable == None:
        fail("%s binding %s must target a Bazel executable" % (ctx.attr.mode, logical_name))

    runfiles_sets = [
        runfiles
        for runfiles in [default_info.default_runfiles, default_info.data_runfiles]
        if runfiles != None
    ]
    transitive_runfiles = [runfiles.files for runfiles in runfiles_sets]
    repo_mapping = files_to_run.repo_mapping_manifest
    direct_runtime_files = [executable]
    for runfiles in runfiles_sets:
        direct_runtime_files.extend([entry.target_file for entry in runfiles.symlinks.to_list()])
        direct_runtime_files.extend([entry.target_file for entry in runfiles.root_symlinks.to_list()])
    if repo_mapping != None:
        direct_runtime_files.append(repo_mapping)
    runtime_files = depset(direct_runtime_files, transitive = transitive_runfiles)

    executable_path = "opt/selamy/bin/%s" % logical_name
    image_files = {executable_path: executable}
    image_modes = {executable_path: _RUNTIME_MODE}
    runfile_paths = {}
    for file in depset(transitive = transitive_runfiles).to_list():
        destination = _runfile_destination(logical_name, _runfile_relative_path(file))
        if _add_image_file(image_files, image_modes, destination, file, _RUNTIME_MODE, "binding %s" % logical_name):
            runfile_paths[destination] = file
    for runfiles in runfiles_sets:
        for entry in runfiles.symlinks.to_list():
            destination = _runfile_destination(logical_name, "_main/" + entry.path)
            if _add_image_file(image_files, image_modes, destination, entry.target_file, _RUNTIME_MODE, "binding %s" % logical_name):
                runfile_paths[destination] = entry.target_file
        for entry in runfiles.root_symlinks.to_list():
            destination = _runfile_destination(logical_name, entry.path)
            if _add_image_file(image_files, image_modes, destination, entry.target_file, _RUNTIME_MODE, "binding %s" % logical_name):
                runfile_paths[destination] = entry.target_file
    if repo_mapping != None:
        repo_mapping_path = _runfile_destination(logical_name, "_repo_mapping")
        if _add_image_file(image_files, image_modes, repo_mapping_path, repo_mapping, _RUNTIME_MODE, "binding %s" % logical_name):
            runfile_paths[repo_mapping_path] = repo_mapping

    package_files = [
        (_package_files({executable_path: executable}, _RUNTIME_MODE), ctx.label),
    ]
    if runfile_paths:
        package_files.append((_package_files(runfile_paths, _RUNTIME_MODE), ctx.label))

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
            image_modes = image_modes,
            logical_name = logical_name,
            mode = ctx.attr.mode,
            runtime_files = runtime_files,
            target_label = str(target.label),
            target_platform = str(ctx.attr.target_platform.label),
        ),
    ]


_appliance_binding = rule(
    implementation = _appliance_binding_impl,
    attrs = {
        "_allowlist_function_transition": attr.label(
            default = "@bazel_tools//tools/allowlists/function_transition_allowlist",
        ),
        "logical_name": attr.string(mandatory = True),
        "mode": attr.string(mandatory = True, values = _MODES),
        "target": attr.label(cfg = _target_platform_transition, mandatory = True),
        "target_platform": attr.label(mandatory = True, providers = [platform_common.PlatformInfo]),
    },
)


def _binding(name, logical_name, mode, target, target_platform, visibility, tags):
    _appliance_binding(
        name = name,
        logical_name = logical_name,
        mode = mode,
        target = target,
        target_platform = target_platform,
        tags = tags,
        visibility = visibility,
    )


def exec_binding(name, logical_name, target, target_platform, visibility = None, tags = None):
    """Binds one fixed executable and its runfiles to an exec capability."""
    _binding(name, logical_name, "exec", target, target_platform, visibility, tags)


def in_process_binding(name, logical_name, target, target_platform, visibility = None, tags = None):
    """Binds the executable closure hosting an in-process Eve capability."""
    _binding(name, logical_name, "in_process", target, target_platform, visibility, tags)


def sidecar_binding(name, logical_name, target, target_platform, visibility = None, tags = None):
    """Binds one fixed executable and its runfiles to a sidecar capability."""
    _binding(name, logical_name, "sidecar", target, target_platform, visibility, tags)


def job_binding(name, logical_name, target, target_platform, visibility = None, tags = None):
    """Binds one fixed executable and its runfiles to a job capability."""
    _binding(name, logical_name, "job", target, target_platform, visibility, tags)


def cronjob_binding(name, logical_name, target, target_platform, visibility = None, tags = None):
    """Binds one fixed executable and its runfiles to a cronjob capability."""
    _binding(name, logical_name, "cronjob", target, target_platform, visibility, tags)


def deployment_binding(name, logical_name, target, target_platform, visibility = None, tags = None):
    """Binds one fixed executable and its runfiles to a deployment capability."""
    _binding(name, logical_name, "deployment", target, target_platform, visibility, tags)


def _agent_appliance_impl(ctx):
    if len(ctx.attr.binding_names) != len(ctx.attr.bindings):
        fail("binding_names and bindings must have identical lengths")
    runtime_transitive = []
    binding_labels = []
    binding_modes = []
    executables = []
    image_files = {}
    image_modes = {}
    package_files = []
    seen_labels = {}
    target_platform = None
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
        if target_platform == None:
            target_platform = binding_info.target_platform
        elif target_platform != binding_info.target_platform:
            fail("bindings use multiple target platforms: %s and %s" % (target_platform, binding_info.target_platform))
        binding_labels.append(canonical_label)
        binding_modes.append(binding_info.mode)
        executables.append(binding_info.executable)
        runtime_transitive.append(binding_info.runtime_files)
        package_files.extend(target[PackageFilegroupInfo].pkg_files)
        for destination, source in binding_info.image_files.items():
            _add_image_file(
                image_files,
                image_modes,
                destination,
                source,
                binding_info.image_modes[destination],
                "appliance %s" % ctx.label,
            )

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
    for destination in metadata_image_files.keys():
        image_modes[destination] = _METADATA_MODE
    package_files.append((_package_files(metadata_image_files, _METADATA_MODE), ctx.label))

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
            architecture = ctx.attr.architecture,
            binding = binding,
            canonical_manifest = canonical_manifest,
            catalog = catalog,
            image_files = image_files,
            image_modes = image_modes,
            os = ctx.attr.os,
            runtime_files = runtime_files,
            target_platform = target_platform,
        ),
    ]


_agent_appliance = rule(
    implementation = _agent_appliance_impl,
    attrs = {
        "agent_name": attr.string(mandatory = True),
        "architecture": attr.string(mandatory = True),
        "manifest": attr.label(allow_single_file = [".yaml", ".yml"], mandatory = True),
        "binding_names": attr.string_list(mandatory = True),
        "bindings": attr.label_list(mandatory = True, providers = [ApplianceBindingInfo]),
        "os": attr.string(mandatory = True),
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


def agent_appliance(name, agent_name, manifest, bindings, architecture, os, visibility = None, tags = None):
    """Validates a manifest, binds typed targets, and emits a runtime layer."""
    if not bindings:
        fail("bindings must be non-empty")
    names = sorted(bindings.keys())
    _agent_appliance(
        name = name,
        agent_name = agent_name,
        architecture = architecture,
        manifest = manifest,
        binding_names = names,
        bindings = [bindings[logical_name] for logical_name in names],
        os = os,
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
    appliance = ctx.attr.appliance[ApplianceInfo]
    platform_checks = ctx.attr.platform_check
    if len(platform_checks) != 1:
        fail("image target platform transition must produce exactly one constraint check")
    target_platform = str(ctx.attr.target_platform.label)
    if appliance.target_platform != target_platform:
        fail("appliance target platform %s does not match image target platform %s" % (appliance.target_platform, target_platform))
    if appliance.os != ctx.attr.os or appliance.architecture != ctx.attr.architecture:
        fail("appliance OCI platform %s/%s does not match image OCI platform %s/%s" % (
            appliance.os,
            appliance.architecture,
            ctx.attr.os,
            ctx.attr.architecture,
        ))
    layout_files = ctx.attr.layout[DefaultInfo].files.to_list()
    if len(layout_files) != 1 or not layout_files[0].is_directory:
        fail("layout must be one rules_oci OCI-layout tree artifact")
    return [
        DefaultInfo(files = depset(layout_files)),
        _ApplianceImageInfo(
            appliance = appliance,
            appliance_label = str(ctx.attr.appliance.label),
            layout = layout_files[0],
        ),
    ]


_appliance_image = rule(
    implementation = _appliance_image_impl,
    attrs = {
        "_allowlist_function_transition": attr.label(
            default = "@bazel_tools//tools/allowlists/function_transition_allowlist",
        ),
        "appliance": attr.label(mandatory = True, providers = [ApplianceInfo]),
        "architecture": attr.string(mandatory = True),
        "layout": attr.label(mandatory = True),
        "os": attr.string(mandatory = True),
        "platform_check": attr.label(
            cfg = _target_platform_transition,
            mandatory = True,
            providers = [_PlatformConstraintCheckInfo],
        ),
        "target_platform": attr.label(mandatory = True, providers = [platform_common.PlatformInfo]),
    },
)


def appliance_oci_image(
        name,
        appliance,
        runtime_layer,
        architecture,
        os,
        target_platform,
        base = None,
        tars = [],
        visibility = None,
        tags = None):
    """Builds an OCI image whose final layer is the declared appliance closure."""
    layout_name = name + "_oci_layout"
    platform_check_name = name + "_platform_check"
    _platform_constraint_check(
        name = platform_check_name,
        architecture = architecture,
        architecture_constraint = _oci_constraint(_OCI_ARCHITECTURE_CONSTRAINTS, architecture, "architecture"),
        os = os,
        os_constraint = _oci_constraint(_OCI_OS_CONSTRAINTS, os, "operating system"),
        tags = (tags or []) + ["manual"],
        target_platform_label = str(target_platform),
        visibility = ["//visibility:private"],
    )
    image_args = {
        "name": layout_name,
        "tars": tars + [runtime_layer],
        "tags": tags,
        "visibility": ["//visibility:private"],
    }
    if base != None:
        image_args["base"] = base
    else:
        image_args["os"] = os
        image_args["architecture"] = architecture
    oci_image(**image_args)
    _appliance_image(
        name = name,
        appliance = appliance,
        architecture = architecture,
        layout = ":" + layout_name,
        os = os,
        platform_check = ":" + platform_check_name,
        target_platform = target_platform,
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
    args.add("--expected-os", appliance.os)
    args.add("--expected-architecture", appliance.architecture)
    args.add("--output", evidence)
    image_sources = []
    for destination in sorted(appliance.image_files.keys()):
        source = appliance.image_files[destination]
        args.add("--image-path", "/" + destination)
        args.add("--source-file", source)
        args.add("--expected-mode", appliance.image_modes[destination])
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
