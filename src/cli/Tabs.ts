/**
 * Session tabs.
 *
 * A tab is one conversation with its own runtime, so switching tabs swaps the
 * whole working state — history, context window, cost, model — without tearing
 * anything down. The manager is deliberately free of any Runtime import: it is
 * index arithmetic over an opaque payload, which keeps it unit-testable.
 */

export interface Tab<T> {
  /** Session id, also the label the store writes to. */
  id: string;
  /** Short human label shown in the strip; updated from the first goal. */
  title: string;
  /** Whatever the caller attaches — in the REPL, a `Runtime`. */
  payload: T;
}

export class TabManager<T> {
  private readonly items: Tab<T>[] = [];
  private index = 0;

  constructor(initial: Tab<T>) {
    this.items.push(initial);
  }

  get size(): number {
    return this.items.length;
  }

  get activeIndex(): number {
    return this.index;
  }

  current(): Tab<T> {
    return this.items[this.index] as Tab<T>;
  }

  at(index: number): Tab<T> | undefined {
    return this.items[index];
  }

  all(): readonly Tab<T>[] {
    return this.items;
  }

  /** Appends a tab and makes it active; returns its index. */
  add(tab: Tab<T>): number {
    this.items.push(tab);
    this.index = this.items.length - 1;
    return this.index;
  }

  /** Wraps forward. A single tab makes this a no-op. */
  next(): number {
    this.index = (this.index + 1) % this.items.length;
    return this.index;
  }

  /** Wraps backward. */
  prev(): number {
    this.index = (this.index - 1 + this.items.length) % this.items.length;
    return this.index;
  }

  /** Jumps to an index, ignoring out-of-range values; returns the active index. */
  select(index: number): number {
    if (index >= 0 && index < this.items.length) this.index = index;
    return this.index;
  }

  /**
   * Closes a tab and keeps the selection sensible: the tab that slid into the
   * closed slot, or the last one when the tail was removed. The final tab is
   * never removed — the REPL always needs somewhere to type.
   */
  close(index: number): boolean {
    if (this.items.length <= 1 || index < 0 || index >= this.items.length) return false;
    this.items.splice(index, 1);
    if (this.index > index) this.index -= 1;
    else if (this.index >= this.items.length) this.index = this.items.length - 1;
    return true;
  }
}

/** A tab label: the goal's first line, clipped, so the strip stays readable. */
export function shortTitle(text: string, limit = 24): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return "untitled";
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}
