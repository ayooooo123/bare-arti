cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-cargo REQUIRED PATHS node_modules/cmake-cargo)

project(bare_arti C)

option(BARE_ARTI_TESTING "Build deterministic addon test hooks" OFF)

if(BARE_ARTI_TESTING AND NOT CMAKE_BUILD_TYPE STREQUAL "Debug")
  message(FATAL_ERROR "BARE_ARTI_TESTING is only valid for Debug builds")
endif()

# cmake-cargo 0.0.4 derives Android as aarch64-unknown-android, which is not a
# Rust target. Override both its Cargo argument and imported archive path with
# the supported Rust triple before add_crate() evaluates either one.
if(ANDROID)
  function(rust_target result)
    rust_cpu(cpu)
    set(${result} "${cpu}-linux-android" PARENT_SCOPE)
  endfunction()
endif()

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

if(BARE_ARTI_TESTING)
  target_compile_definitions(${bare_arti_module} PRIVATE BARE_ARTI_TESTING=1)
endif()
