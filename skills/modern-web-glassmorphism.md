---
name: modern-web-glassmorphism
description: Build modern dark interfaces with real glassmorphism, asymmetric Bento grids, inline SVG icons, mobile-first responsive layout and zero emojis.
version: 1
when_to_use: Use for any landing page, dashboard, SaaS UI, portfolio or web app that must look like a 2026 engineering studio product.
tags: [web ui ux glassmorphism dark bento grid responsive css tailwind landing dashboard saas design frontend zero-emoji svg pagina sitio interfaz diseno landing-page web-app] 
---
# Modern dark glassmorphism UI

## Direction

Build a quiet, high-contrast interface. The page should read as engineered, not
decorated: one accent colour, generous space, precise alignment and a visible
hierarchy. Default to the dark palette below unless the operator explicitly asks
for a light product.

## Design tokens

```css
:root {
  --bg-0: #07090e;
  --bg-1: #0b0f17;
  --bg-2: #111827;
  --surface: rgba(255, 255, 255, 0.03);
  --surface-strong: rgba(255, 255, 255, 0.06);
  --border: rgba(255, 255, 255, 0.08);
  --text-0: #f9fafb;
  --text-1: #9ca3af;
  --accent: #00ff88;
  --accent-soft: #10b981;
  --radius: 18px;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}
```

- Glass surfaces: `background: var(--surface)`, `backdrop-filter: blur(16px)`,
  `border: 1px solid var(--border)`. Never stack blur on blur.
- Accent use is scarce: one primary action, one active state, one data highlight.
  A neon glow is `box-shadow: 0 0 0 1px rgba(0,255,136,0.25), 0 12px 40px rgba(0,255,136,0.12)`.
- Add a very subtle background atmosphere: one radial gradient at 8% opacity,
  not a rainbow and not animated noise.

## Typography

- UI: Inter or Plus Jakarta Sans. Technical values: JetBrains Mono.
- Scale: 12, 14, 16, 20, 28, 40, 56. Line height 1.5 for body, 1.05 for display.
- Headlines are short and left-aligned. No centered paragraph walls.
- Use `font-variant-numeric: tabular-nums` for metrics and prices.

## Layout

- Build a Bento grid with CSS Grid: `grid-template-columns: repeat(12, 1fr)`,
  cards spanning 4, 6 or 8 columns. Vary card heights; do not make a uniform
  3x3 of equal boxes.
- Mobile-first: one column under 640px, two under 1024px, the full grid above.
- Keep an 8px spacing scale and a maximum content width around 1200px.
- Every card has one job. If a card needs three unrelated actions, split it.

## Interaction

- Transitions use `var(--ease)` at 180–320ms. Hover lifts by 2px and brightens
  the border; it does not scale the whole card by 1.2.
- Focus is always visible: a 2px accent ring with a 2px offset.
- Loading states are skeleton blocks or a small geometric spinner, never a
  layout shift.

## Icons and imagery

- CERO EMOJIS en la interfaz. Use inline SVG (Lucide or Tabler paths) at 18–24px
  with `stroke="currentColor"` and `stroke-width="1.75"`.
- A geometric indicator (a dot, a bar, a chevron) is better than a novelty icon.
- Imagery: one strong product visual or abstract render per section, cropped
  deliberately. No stock-photo collages.

## Required checks

1. The page loads with no console errors.
2. At 375px, 768px and 1440px there is no horizontal scroll.
3. Every interactive element is reachable by keyboard and has a visible focus.
4. Colour contrast for body text is at least 4.5:1.
5. No emoji appears in HTML, CSS, JSX, Vue or Svelte.
6. Run the project's build or typecheck before declaring the work complete.
