---
name: api-design
description: Design HTTP and library APIs: resources, errors, versioning, pagination, idempotency and compatibility.
version: 1
when_to_use: Use when designing or changing an API, adding endpoints, or reviewing an interface contract.
tags: [api rest http design versioning pagination idempotency errors contract]
---
# API design

## Resources

- Nouns for resources, HTTP verbs for actions. `POST /orders`, `GET /orders/{id}`.
- Plural collections, stable ids, no verbs in paths. An action that does not fit
  CRUD is a sub-resource (`POST /orders/{id}/cancellations`).
- Use the right status: 201 with `Location` on create, 202 for accepted async
  work, 204 for empty success, 409 for conflict, 422 for semantic validation.

## Errors

- One error shape everywhere: a machine `code`, a human `message`, and optional
  `details` with field-level problems.
- Never return 200 with an error body. Never leak stack traces or internal ids.
- Validation errors name the field and the rule.

## Pagination, filtering, sorting

- Cursor pagination for large or changing collections; offset pagination only for
  small, stable sets. Always cap page size.
- Filter and sort parameters are documented and whitelisted. Never pass them
  straight into SQL.

## Idempotency and retries

- `PUT` and `DELETE` are idempotent by definition; make them so.
- For unsafe `POST`s that clients retry, accept an idempotency key and return the
  original result on replay.
- Timeouts are normal: assume every client retries.

## Compatibility

- Additive changes are safe: new optional field, new endpoint. Removing a field,
  changing a type, tightening validation or changing a default are breaking.
- Version when you must, and keep at most two versions alive. Deprecate with a
  header and a date, not a surprise.
- Document the contract (OpenAPI) and generate types from it so client and server
  cannot drift.

## Library APIs

- Small surface, obvious names, no required ceremony. A caller should succeed
  with the defaults.
- Accept options objects for growth; positional booleans rot.
- Errors are typed and documented. Return values, not out-parameters.
