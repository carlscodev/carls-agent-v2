import type { EventBus } from "../core/EventBus.js";
import { theme } from "./Theme.js";
import { terminalDimension, truncate, visibleWidth } from "./Text.js";

/**
 * Floating notifications for the full-screen TUI.
 *
 * A skill being injected, a shadow-git checkpoint, a compaction layer: each is a
 * fact the user benefits from seeing once, but none deserves a permanent row in
 * the transcript. Toasts show them briefly in the top-right corner and expire on
 * their own.
 *
 * Two rules matter for a terminal. The layout must not shift, so the toasts are
 * overlaid by the caller at a fixed row rather than pushed into the stream. And
 * every timer must be tracked and cleared, because a toast left behind keeps a
 * timer alive and repaints the screen after the turn has ended.
 */

export type ToastTone = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  /** Epoch ms the toast was created. */
  createdAt: number;
  /** Lifetime in ms. */
  ttl: number;
}

interface TimerHandle {
  unref?: () => void;
}

export interface ToastManagerOptions {
  /** Auto-expiry, default 2500 ms. */
  ttl?: number;
  /** Rows kept on screen at once; older ones are dropped. */
  max?: number;
  /** Called whenever the visible set changes, so the view can repaint. */
  onChange?: (toasts: readonly Toast[]) => void;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Schedule/cancel primitives, injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

function toneGlyph(tone: ToastTone): string {
  const t = theme();
  switch (tone) {
    case "success":
      return t.paint(t.colors.feedback.success, "✓");
    case "warning":
      return t.paint(t.colors.feedback.warning, "◆");
    case "error":
      return t.paint(t.colors.feedback.error, "✗");
    default:
      return t.paint(t.colors.feedback.info, "●");
  }
}

/**
 * One-line toast frame: `╭─ ● text ──╮`. Fitted to `width` columns so an overlay
 * never wraps into the row below it.
 */
export function renderToast(text: string, tone: ToastTone = "info", width = terminalDimension(undefined, 80)): string {
  const t = theme();
  const body = `${toneGlyph(tone)} ${text}`;
  // Frame cost: `╭─` + space + space + `─╮` = six columns around the body.
  const inner = Math.max(4, width - 6);
  const fitted = truncate(body, inner);
  const pad = Math.max(0, inner - visibleWidth(fitted));
  return `${t.paint(t.colors.border, "╭─")} ${fitted}${" ".repeat(pad)} ${t.paint(t.colors.border, "─╮")}`;
}

export class ToastManager {
  private readonly ttl: number;
  private readonly max: number;
  private readonly onChange: (toasts: readonly Toast[]) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly toasts: Toast[] = [];
  private readonly timers = new Map<number, TimerHandle>();
  private nextId = 1;
  private disposed = false;

  constructor(options: ToastManagerOptions = {}) {
    this.ttl = Math.max(1, options.ttl ?? 2500);
    this.max = Math.max(1, options.max ?? 3);
    this.onChange = options.onChange ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Visible toasts, oldest first. */
  get active(): readonly Toast[] {
    return this.toasts;
  }

  /** Number of live expiry timers, for the leak regression test. */
  get timerCount(): number {
    return this.timers.size;
  }

  /** Shows a toast and schedules its expiry. */
  show(text: string, tone: ToastTone = "info", ttl?: number): Toast {
    const toast: Toast = {
      id: this.nextId++,
      text,
      tone,
      createdAt: this.now(),
      ttl: Math.max(1, ttl ?? this.ttl),
    };
    if (this.disposed) return toast;
    this.toasts.push(toast);
    while (this.toasts.length > this.max) {
      const dropped = this.toasts.shift();
      if (dropped !== undefined) this.cancelTimer(dropped.id);
    }
    this.timers.set(toast.id, this.setTimer(() => this.expire(toast.id), toast.ttl));
    this.onChange(this.toasts);
    return toast;
  }

  /** Removes every toast whose TTL has passed. Returns the number removed. */
  prune(at: number = this.now()): number {
    const survivors = this.toasts.filter((toast) => at - toast.createdAt < toast.ttl);
    const removed = this.toasts.length - survivors.length;
    if (removed === 0) return 0;
    for (const toast of this.toasts) {
      if (!survivors.includes(toast)) this.cancelTimer(toast.id);
    }
    this.toasts.length = 0;
    this.toasts.push(...survivors);
    this.onChange(this.toasts);
    return removed;
  }

  private expire(id: number): void {
    this.timers.delete(id);
    const index = this.toasts.findIndex((toast) => toast.id === id);
    if (index === -1) return;
    this.toasts.splice(index, 1);
    this.onChange(this.toasts);
  }

  private cancelTimer(id: number): void {
    const handle = this.timers.get(id);
    if (handle === undefined) return;
    this.clearTimer(handle);
    this.timers.delete(id);
  }

  /** Clears every toast and timer. Called at the end of a turn and on exit. */
  dispose(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
    this.toasts.length = 0;
    this.disposed = true;
    this.onChange(this.toasts);
  }

  /**
   * Draws the stack as a right-aligned overlay block. `rows` is the number of
   * lines available; the caller positions it at a fixed origin so the layout
   * never shifts. Each toast is one line, fitted to `width`.
   */
  render(width?: number, rows?: number): string[] {
    const budget = width ?? terminalDimension(undefined, 80);
    const visible = rows !== undefined ? this.toasts.slice(-rows) : [...this.toasts];
    return visible.map((toast) => renderToast(toast.text, toast.tone, budget));
  }
}

/**
 * Wires the facts worth a toast to the manager. Deliberately narrow: only things
 * the user would otherwise miss become notifications, so the corner never turns
 * into a scrolling log. Returns the unsubscribe function.
 */
export function attachToastBus(bus: EventBus, manager: ToastManager): () => void {
  const offs: Array<() => void> = [];
  offs.push(
    bus.on("compaction.layer", (event) => {
      if (event.applied) manager.show(`Contexto compactado (Capa ${event.layer})`, "info");
    }),
  );
  offs.push(
    bus.on("subagent.status", (event) => {
      if (event.phase === "done" && event.ok === true) manager.show(`Subagente ${event.role} terminado`, "success");
      else if (event.phase === "failed") manager.show(`Subagente ${event.role} falló`, "error");
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}
