---
name: php
description: Write and review modern PHP: types, Composer, PSR standards, frameworks and security.
version: 1
when_to_use: Use for .php work, Laravel or Symfony projects, or Composer and PSR issues.
tags: [php composer laravel symfony psr phpstan typing security]
---
# PHP

## Language

- PHP 8.2+ with `declare(strict_types=1);` at the top of every file.
- Type everything: parameters, returns, properties, and typed constants. Union and
  intersection types where the domain needs them.
- Enums for closed sets. Readonly properties and constructor promotion for value
  objects.
- Named arguments at call sites for booleans and config-heavy functions.
- Never use `@` to suppress errors, `extract()`, or variable variables.

## Structure

- Composer with a committed `composer.lock`. `composer audit` in CI.
- PSR-4 autoloading, PSR-12 style via `php-cs-fixer`. Static analysis with
  `phpstan` level 6+ or `psalm`.
- Dependency injection over service locators. Constructor injection, no
  `new` for collaborators in the middle of business logic.

## Framework notes

- Laravel: form requests for validation, API resources for output, policies for
  authorization, queues for slow work. Avoid fat controllers.
- Symfony: keep controllers thin, put logic in services, use the Messenger
  component for async.

## Security

- Escape output (`htmlspecialchars` with `ENT_QUOTES`) or use the template engine,
  which does it for you. Never echo user input raw.
- Prepared statements only; never interpolate into SQL.
- `password_hash` / `password_verify` with the default algorithm. Never md5/sha1
  for passwords.
- Validate and whitelist file paths; `..` in a path is an attack.

## Testing

- PHPUnit with data providers. Pest when the team prefers it.
- Test against a real database (SQLite in-memory or a container), not mocks of
  the ORM.
