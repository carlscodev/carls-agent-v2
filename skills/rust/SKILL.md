---
name: rust
description: Write and review Rust: ownership, error handling, traits, async and cargo.
version: 1
when_to_use: Use for any .rs work, cargo projects, or borrow-checker and lifetime issues.
tags: [rust cargo ownership borrow lifetime trait async tokio error clippy]
---
# Rust

## Ownership and borrowing

- Prefer borrowing over cloning. Clone only when the value is small or the
  lifetime genuinely ends.
- Return `&str` and `&[T]` from accessors; take `&str` instead of `&String`.
- When the borrow checker fights you, the design is usually wrong: split the
  struct, or take ownership and return it.
- `Cow<'_, str>` when a function sometimes borrows and sometimes allocates.

## Errors

- Libraries: `thiserror` for typed errors. Applications: `anyhow` for context,
  and `?` everywhere.
- Never `unwrap()` on I/O or user input in a library. `expect("invariant: ...")`
  only for genuinely impossible states, with the reason.
- Add context with `.context("reading config")?` so the chain reads as a story.

## Types

- Newtypes for domain meaning: `struct UserId(u64)` prevents mixing ids.
- Enums with data model states; make illegal states unrepresentable.
- `Option` for absence, `Result` for failure. Never a sentinel value.
- Derive `Debug` everywhere; `Clone`, `PartialEq`, `Eq`, `Hash` when meaningful.

## Async

- `tokio` for network services. Do not block inside async: use
  `spawn_blocking` for CPU or blocking I/O.
- `select!` for racing and cancellation; document which branch wins.
- Pin only when you must. Boxed futures are a last resort for size, not a habit.

## Tooling

- `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test`. Clippy knows more than
  you do about idiom.
- `cargo nextest` for faster, clearer test output on large suites.
