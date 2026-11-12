---
name: frontend-web
description: Build and review front-end web code: semantics, accessibility, state, performance and styling.
version: 1
when_to_use: Use for HTML, CSS, React/Vue/Svelte components, or any browser-facing UI work.
tags: [frontend html css react vue svelte accessibility a11y performance state]
---
# Front-end web

## Semantics and accessibility

- Real elements: `button`, `a`, `input`, `label`, `nav`, `main`, `dialog`. A `div`
  with `onClick` is not a button and breaks keyboards and screen readers.
- Every image has `alt` (empty for decorative). Every input has a label.
- Focus is visible and managed: focus the dialog on open, return it on close, trap
  it while open.
- Colour contrast at least 4.5:1 for text. Never rely on colour alone.
- Test with the keyboard only, then with a screen reader. It is fast and finds
  real bugs.

## State

- Server state (fetch/cache) is different from UI state. Use a query library for
  the former; do not hand-roll caching with `useEffect`.
- Derive instead of duplicating. Two sources of truth for the same value is a bug
  waiting for a race.
- Keep state as local as possible. Lift only when two components genuinely share
  it. Global state is a last resort, not a default.
- URL is state: filters, tabs and pagination belong in the address bar so a link
  reproduces the view.

## Performance

- Measure with the browser's performance panel before optimising.
- Ship less JavaScript. Server-render or pre-render when the page is mostly
  static.
- Optimise images (right size, modern format, lazy below the fold) and fonts
  (subset, `font-display: swap`, preload the one used above the fold).
- Avoid layout thrash: batch reads then writes, animate `transform`/`opacity`
  only.
- Memoise a component only after profiling shows it re-renders too often.

## Styling

- A token layer for colour, spacing, type and radius. Components consume tokens;
  no magic hex codes in components.
- Layout with flexbox and grid, not absolute positioning.
- Design the empty, loading, error and long-content states. Truncation, wrapping
  and overflow are part of the component, not an afterthought.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`.

## Quality

- No console errors or warnings in the shipped app.
- Handle slow networks and offline: timeouts, retries, optimistic updates with
  rollback.
- Forms: validate on submit and on blur, show errors next to the field, never
  lose the user's input on failure.
