---
name: java-jvm
description: Write and review Java and JVM code: modern language features, build tools, concurrency and performance.
version: 1
when_to_use: Use for Java, Kotlin, Scala, Spring, Gradle or Maven work.
tags: [java jvm kotlin gradle maven spring streams records jvm gc]
---
# Java and the JVM

## Modern Java

- Java 17+ as the floor, 21 when you can. Records for data, `sealed` for closed
  hierarchies, pattern matching in `switch` instead of instanceof chains.
- `Optional` for return types, never for fields or parameters.
- Text blocks for multi-line strings. `var` for obvious local types only.
- Streams for transformations, not for loops with side effects. If the lambda
  mutates state, use a loop.

## Errors and resources

- Checked exceptions for recoverable conditions, unchecked for programming
  errors. Wrap checked exceptions at the boundary, keeping the cause.
- try-with-resources for everything `AutoCloseable`. No manual `finally` closes.
- Never catch `Exception` and log-and-continue; that hides real failures.

## Concurrency

- Virtual threads (21+) for blocking I/O at scale. Structured concurrency to keep
  lifetimes scoped.
- `CompletableFuture` for composition; avoid raw `Thread` and `synchronized` when
  `java.util.concurrent` has the tool.
- Immutability first: `final` fields, unmodifiable collections, records.

## Build and JVM

- Gradle Kotlin DSL with a version catalog, or Maven with `dependencyManagement`.
  Pin every plugin version.
- Reproducible builds: pin the toolchain, do not depend on the machine JDK.
- Profile with async-profiler or JFR before tuning. Most "slow" is allocation or
  a bad query, not GC.

## Testing

- JUnit 5, `@ParameterizedTest` for cases, AssertJ for readable assertions.
- Testcontainers for databases instead of an in-memory fake that lies.
