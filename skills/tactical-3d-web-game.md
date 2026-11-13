---
name: tactical-3d-web-game
description: Build browser games with Three.js or Canvas and Vite + TypeScript: decoupled game loop, spatial hashing, keyboard and touch controls, clean HUD and measurable performance.
version: 1
when_to_use: Use when creating a 2D or 3D web game, a playable prototype, a game HUD or a Three.js scene that must run at a stable frame rate.
tags: [game three.js threejs webgl canvas vite typescript game-loop spatial-hash collision hud input touch keyboard performance 3d 2d juego juegos videojuego jugabilidad] 
---
# Tactical web game architecture

## Project shape

```
src/
  main.ts             bootstrap, canvas, resize, visibility
  core/
    Game.ts           fixed-step update + render orchestration
    Loop.ts           requestAnimationFrame, accumulator, interpolation
    Input.ts          keyboard, pointer, touch, gamepad, remapping
  ecs/ or entities/   small data objects, no inheritance trees
  systems/            movement, collision, spawning, scoring
  render/             scene, materials, camera, post-processing
  ui/                 HUD, menus, settings; DOM overlay or canvas
  content/            generated data, levels, tuning constants
```

- Keep simulation independent from rendering. `update(dt)` must be callable in a
  test without a browser or a WebGL context.
- Use a fixed step (60 Hz) with an accumulator and clamp the maximum catch-up to
  avoid a spiral of death after a tab returns from the background.

## Loop and performance

```ts
const STEP = 1 / 60;
let accumulator = 0;
let last = performance.now();

function frame(now: number): void {
  const delta = Math.min(0.25, (now - last) / 1000);
  last = now;
  accumulator += delta;
  while (accumulator >= STEP) {
    world.update(STEP);
    accumulator -= STEP;
  }
  renderer.render(world, accumulator / STEP);
  requestAnimationFrame(frame);
}
```

- Pool bullets, particles and enemies; never allocate in the hot loop.
- Reuse vectors and matrices. `new THREE.Vector3()` per frame is garbage.
- Batch static geometry, use instancing for repeated meshes, cap pixel ratio at 2.
- Measure with `renderer.info` and the browser performance panel before claiming
  a frame rate. Target 60fps on a mid-range laptop, 30fps floor on mobile.

## Collision and space

- Broad phase: a uniform spatial hash sized to the largest object. Rebuild it
  once per update, not per pair.
- Narrow phase: circles or AABBs first; add OBB or mesh tests only where the
  gameplay needs them.
- Keep a deterministic iteration order for collisions so replays and tests are
  stable.

## Input

- One action map (`move`, `aim`, `fire`, `pause`, `confirm`) with keyboard,
  pointer, touch and gamepad bindings. The game code never reads raw key codes.
- Pointer lock for first-person; virtual joystick plus a fire zone for touch.
- Pause the simulation when the document is hidden and on window blur.
- Provide a visible control legend and a remap screen; persist bindings.

## HUD and art direction

- HUD: dark translucent panels, neon accent for the active/primary value, one
  typeface for labels and a mono face for numbers. Keep it at the edges; never
  cover the play space.
- CERO EMOJIS en la interfaz. Use inline SVG or geometric marks for health,
  ammo, timer and minimap markers.
- Readability first: silhouette, contrast and motion. A stylised low-poly or
  pixel look is fine; unreadable clutter is not.
- Menu and HUD use the same tokens as the rest of the product (`--bg-0`,
  `--accent`, `--border`) so the game feels like one system.

## Verification

1. `npm run build` succeeds with strict TypeScript.
2. The game boots, accepts input and renders at a stable frame rate.
3. Collision and scoring have at least one deterministic unit test.
4. Resize, visibility change and pointer lock release do not break the loop.
5. No emoji appears in the HUD, menus, textures or code comments.
