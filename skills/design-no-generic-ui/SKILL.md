---
name: design-no-generic-ui
description: Hard rules for interfaces that look designed rather than auto-generated. Applies to web, TUI and generated artifacts.
version: 1
when_to_use: Use before building or restyling any interface, page, component or terminal UI.
tags: [design ui ux frontend aesthetics typography layout anti-generic craft]
---
# Nothing may look generic

Auto-generated interfaces share a look. Avoid all of it.

## Banned by default

- Purple-to-blue gradients on white. Bootstrap-blue buttons. Default rounded
  corners everywhere with the same radius.
- Centered hero with a big heading, a paragraph and two buttons, in that order.
- Three feature cards with a line icon, a bold title and two lines of filler.
- Placeholder text: "Lorem ipsum", "Your headline here", "Feature One".
- Emoji as icons. Stock illustrations. Random gradients behind headings.
- Emoji-decorated headings in documents and READMEs.

## Do this instead

1. **Decide the personality first.** Write one sentence: "a technical
   instrument panel", "a printed field guide", "an editorial magazine". Every
   later choice must serve it.
2. **Pick a real type scale.** Two families at most. Vary weight and size to
   build hierarchy, not color alone. Set line height and measure deliberately.
3. **Use a restrained palette with one accent.** Neutrals carry the layout; the
   accent marks the single most important action per screen. Contrast must clear
   4.5:1 for text.
4. **Build a grid and break it once.** Aligned edges everywhere, then one
   deliberate asymmetry that directs the eye.
5. **Space is a feature.** Generous, consistent spacing reads as quality.
6. **Real content.** Use the actual domain language. If you need a label, invent
   a specific one, never "Item 1".
7. **Motion with intent.** Short transitions that clarify state.
8. **Every state designed.** Empty, loading, error, partial and full.
9. **Details that prove care.** Focus rings that fit the design, tabular numbers
   for data, a favicon, sensible page titles, honest error messages.

## Review pass

Screenshot it, or dump the rendered text for a TUI. Then ask: would someone
believe this shipped from a product team? If any element could be swapped into a
different project unchanged, it is generic. Replace it.
