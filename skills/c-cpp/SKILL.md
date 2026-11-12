---
name: c-cpp
description: Write and review C and C++: memory safety, modern C++, build systems and tooling.
version: 1
when_to_use: Use for .c/.h/.cc/.cpp/.hpp work, CMake, or memory and undefined-behavior bugs.
tags: [c cpp cmake memory leak sanitizer valgrind smart pointer raii undefined behavior]
---
# C and C++

## Memory and safety

- C: every `malloc` has exactly one `free` on every path, including error paths.
  Prefer one allocation and one cleanup block with `goto out;` over nested frees.
- C++: RAII. `std::unique_ptr` for ownership, `std::shared_ptr` only when sharing
  is real, raw pointers for non-owning views. No `new`/`delete` in application code.
- Never return a pointer to a local. Never use a container element pointer after
  a reallocation.
- Bounds-check: `std::span`, `std::string_view`, `at()` in debug. `strncpy` and
  `sprintf` are bugs; use `snprintf` and explicit lengths.

## Modern C++ (17/20/23)

- `auto` for obvious types, `constexpr` for compile-time values, `std::optional`
  for absence, `std::variant` for closed unions.
- Structured bindings, ranges, `std::format` (20+) over iostreams.
- Move semantics: define move operations when you own a resource; delete copies
  if copying is wrong.
- `noexcept` on moves and destructors. `[[nodiscard]]` on functions whose result
  matters.

## Undefined behavior

- Signed overflow, out-of-bounds access, use-after-free and data races are UB,
  not "works on my machine". Fix the cause; do not tune optimizations around it.

## Tooling

- CMake with targets, not global flags. `target_link_libraries` with `PUBLIC`/
  `PRIVATE` scopes.
- `-Wall -Wextra -Werror`, plus ASan/UBSan in a debug build, TSan for threads.
  `valgrind` when you cannot rebuild.
- `clang-format` and `clang-tidy` in CI. `ccache` locally.
