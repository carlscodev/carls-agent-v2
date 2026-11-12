---
name: go
description: Write and review idiomatic Go: errors, concurrency, interfaces, modules and tooling.
version: 1
when_to_use: Use for any .go work, services, CLIs, or Go module and build issues.
tags: [go golang goroutine channel error interface module testing]
---
# Go

## Errors

- Return errors; do not panic for expected failures. `panic` is for programmer
  error and unreachable states.
- Wrap with context: `fmt.Errorf("loading config %s: %w", path, err)`. Use `%w`
  so `errors.Is`/`errors.As` keep working.
- Sentinel errors for callers to match, custom types when they need fields.
- Check every error. `_ =` on a fallible call needs a comment saying why.

## Concurrency

- "Do not communicate by sharing memory; share memory by communicating." Channels
  for ownership transfer, `sync.Mutex` for guarding state.
- Every goroutine needs an exit: a `context.Context`, a done channel or a bounded
  loop. A leaked goroutine is a leak.
- `context.Context` is the first parameter, never stored in a struct.
- Bound worker pools. Unbounded `go func()` per item melts under load.
- `go test -race` before you trust any concurrent code.

## Interfaces

- Accept interfaces, return structs. Keep interfaces small; one or two methods.
- Define the interface where it is consumed, not where it is implemented.
- Do not use an interface for a single implementation with no test double.

## Layout and tooling

- `gofmt`/`goimports` always. `go vet` and `staticcheck` in CI.
- Table-driven tests with `t.Run` subtests. `t.Cleanup` for teardown.
- Avoid `init()` except for registering drivers; it hides ordering.
- Pass `-trimpath` and set `-ldflags "-s -w"` for smaller binaries.
