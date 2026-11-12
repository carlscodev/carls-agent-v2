---
name: security-review
description: Review code for security: injection, authz, secrets, crypto, dependencies and unsafe deserialization.
version: 1
when_to_use: Use before shipping anything that handles user input, credentials, or money.
tags: [security review injection authorization secrets crypto owasp dependency audit]
---
# Security review

## Input

- Validate at the boundary and reject by default (allowlist, not denylist).
- Injection: SQL via parameterised statements, shell via argument arrays (never
  string concatenation into `sh -c`), templates via escaping or a safe engine.
- Paths: resolve and confirm the result stays inside the intended root. `..` and
  symlinks are attacks.
- Deserialisation of untrusted data is remote code execution waiting to happen.
  Prefer JSON with a schema; never `pickle`, `eval` or native object streams on
  input.
- Bound everything: body size, upload size, recursion depth, regex complexity
  (ReDoS), array length.

## Authentication and authorization

- Check authorization on every request server-side. Hiding a button is not
  authorization.
- Session tokens: httpOnly, secure, sameSite cookies, rotated on privilege change.
- Compare secrets in constant time. Rate-limit login and password reset.
- Do not leak whether an account exists in login or reset flows.

## Secrets

- No secrets in code, config committed to git, images, logs or error messages.
- Rotate anything that has ever been committed; assume it is public.
- Load from the environment or a secret manager, and fail closed when absent.

## Crypto

- Never roll your own. Use the platform's `crypto`.
- Passwords: bcrypt, scrypt or argon2 with tuned cost. Never md5/sha1.
- Randomness from a CSPRNG, not `Math.random`/`rand()`.
- Verify signatures before parsing the payload.

## Dependencies

- `npm audit`, `pip-audit`, `govulncheck`, `cargo audit` in CI.
- Pin versions and review lockfile diffs. A new transitive dependency is new
  attack surface.

## Reporting

State the impact, the exact location, and the smallest fix. Do not just flag a
pattern; explain how it is exploitable and how to prove the fix works.
