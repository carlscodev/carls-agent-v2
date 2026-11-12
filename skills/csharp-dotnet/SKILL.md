---
name: csharp-dotnet
description: Write and review C# and .NET: async, LINQ, records, DI, EF Core and tooling.
version: 1
when_to_use: Use for .cs/.csproj work, ASP.NET Core services, or .NET tooling issues.
tags: [csharp dotnet aspnet efcore linq async nullable record nuget]
---
# C# and .NET

## Language

- Nullable reference types on (`<Nullable>enable</Nullable>`). Do not paper over
  warnings with `!`; fix the flow.
- `record` and `record struct` for data. `init` and `required` for immutable
  construction.
- Pattern matching over `is`/`as` chains. `switch` expressions for mapping.
- `var` when the type is obvious from the right-hand side; explicit types
  otherwise.

## Async

- `async` all the way down. Never `.Result` or `.Wait()` on a task; that is a
  deadlock waiting for a sync context.
- Suffix async methods with `Async`, take a `CancellationToken`, pass it on.
- `ConfigureAwait(false)` in libraries. `ValueTask` for hot paths that usually
  complete synchronously.
- `IAsyncEnumerable<T>` for streaming instead of materialising a huge list.

## LINQ and data

- One query, one meaning. Avoid `.Where().First()` when `.First(predicate)` exists.
- Materialise once: `ToList()` at the boundary you actually need, not eagerly
  everywhere.
- EF Core: `AsNoTracking()` for reads, project with `Select` instead of loading
  whole graphs, and watch for N+1 in loops. Log the generated SQL in dev.
- Dispose `DbContext` per unit of work; never share across threads.

## Tooling

- `<TreatWarningsAsErrors>` in CI. `dotnet format` for style.
- Pin the SDK in `global.json`. Central package management for versions.
- `dotnet test` with xUnit; `WebApplicationFactory` for integration tests.
