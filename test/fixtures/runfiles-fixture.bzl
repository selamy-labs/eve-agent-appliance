"""Executable fixture with distinct default/data runfiles mappings."""


def _runfiles_fixture_impl(ctx):
    executable = ctx.actions.declare_file(ctx.label.name)
    default_tool = ctx.actions.declare_file(ctx.label.name + ".default-tool")
    default_data = ctx.actions.declare_file(ctx.label.name + ".default-data")
    data_tool = ctx.actions.declare_file(ctx.label.name + ".data-tool")
    data_data = ctx.actions.declare_file(ctx.label.name + ".data-data")
    shared_tool = data_tool if ctx.attr.conflicting_mappings else default_tool
    shared_data = data_data if ctx.attr.conflicting_mappings else default_data

    ctx.actions.write(executable, "#!/bin/sh\nexit 0\n", is_executable = True)
    ctx.actions.write(default_tool, "#!/bin/sh\nexit 0\n", is_executable = True)
    ctx.actions.write(default_data, "default data\n")
    ctx.actions.write(data_tool, "#!/bin/sh\nexit 0\n", is_executable = True)
    ctx.actions.write(data_data, "data data\n")

    default_runfiles = ctx.runfiles(
        files = [default_tool, default_data],
        root_symlinks = {
            "root/default-data": default_data,
            "root/shared-data": default_data,
        },
        symlinks = {
            "mapped/default-tool": default_tool,
            "mapped/shared-tool": default_tool,
        },
    )
    data_runfiles = ctx.runfiles(
        files = [data_tool, data_data],
        root_symlinks = {
            "root/data-data": data_data,
            "root/shared-data": shared_data,
        },
        symlinks = {
            "mapped/data-tool": data_tool,
            "mapped/shared-tool": shared_tool,
        },
    )
    return [DefaultInfo(
        data_runfiles = data_runfiles,
        default_runfiles = default_runfiles,
        executable = executable,
        files = depset([executable]),
    )]


runfiles_fixture = rule(
    implementation = _runfiles_fixture_impl,
    attrs = {"conflicting_mappings": attr.bool()},
    executable = True,
)


def _typed_image_validation_test_impl(ctx):
    outputs = ctx.attr.image[DefaultInfo].files.to_list()
    if len(outputs) != 1 or not outputs[0].is_directory or not outputs[0].basename.endswith(".validated-layout"):
        fail("typed image must expose one validated OCI layout tree")
    executable = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.write(executable, "#!/bin/sh\nexit 0\n", is_executable = True)
    return [DefaultInfo(executable = executable)]


typed_image_validation_test = rule(
    implementation = _typed_image_validation_test_impl,
    attrs = {"image": attr.label(mandatory = True)},
    test = True,
)
