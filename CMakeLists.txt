cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-cargo REQUIRED PATHS node_modules/cmake-cargo)

project(bare_arti C)

# cmake-cargo 0.0.4 accepts a manifest containing one staticlib target. Keep
# that target separate from the root crate, which also contains the sidecar bin.
# cmake-cargo 0.0.4 parses arguments starting at index 1, so its first
# positional argument is intentionally a placeholder before MANIFEST.
add_crate(addon MANIFEST addon/Cargo.toml)

add_bare_module(bare_arti_module)

target_sources(
  ${bare_arti_module}
  PRIVATE
    binding.c
)

target_link_libraries(
  ${bare_arti_module}
  PRIVATE
    bare_arti_addon
)
