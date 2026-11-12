---
name: python
description: Write and review Python: typing, packaging, async, testing and performance.
version: 1
when_to_use: Use for any .py work, scripts, data pipelines, FastAPI services or Python packaging.
tags: [python typing mypy pytest packaging uv asyncio poetry ruff]
---
# Python

## Style and types

- Format and lint with `ruff` (or black + isort + flake8). One tool beats three.
- Annotate public functions. `mypy --strict` on new packages; `--check-untyped-defs`
  at minimum on existing code.
- Use `from __future__ import annotations` for cheap forward references.
- Prefer `dataclasses` or `attrs` for plain data, `pydantic` at I/O boundaries for
  validation. Do not hand-validate JSON with `dict.get` chains.
- No mutable default arguments. `def f(items: list[str] | None = None)`.

## Structure

- `src/` layout with a `pyproject.toml`. Declare dependencies once; no
  `requirements.txt` drift.
- Entry points: `[project.scripts]`, not a bare `if __name__ == "__main__"` in a
  module that is also imported.
- Exceptions: define a base error per package, raise specific subclasses, never
  `except Exception: pass`.

## Async and concurrency

- `asyncio` for I/O-bound work; `concurrent.futures` or `multiprocessing` for CPU
  work. The GIL means threads do not help CPU-bound code.
- Never call blocking I/O inside `async def`; use `asyncio.to_thread`.
- Cancel tasks properly: keep references, `await task` in a `finally`, and
  suppress `asyncio.CancelledError` only when you mean it.

## Performance

- Measure with `time.perf_counter`, not vibes. `python -m cProfile` for hot paths.
- Move per-item work out of loops: compile regexes once, batch DB writes, use
  set/dict lookups instead of list scans.

## Testing

- `pytest` with fixtures, `tmp_path` for files, `monkeypatch` for env.
- Parametrize instead of copy-pasting cases. Assert on values, not log text.
- Test the real code path; stub only what crosses the network.
