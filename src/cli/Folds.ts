/**
 * Long tool output is printed truncated so a single `bash` call cannot push the
 * whole conversation off screen. The full text is kept here instead of being
 * thrown away, so one key press can bring it back.
 *
 * The store is a module singleton, matching `theme()`: `ToolView` renders the
 * collapsed block deep inside the agent loop and has no access to the REPL's
 * state, so the two sides meet here.
 */

export interface Fold {
  id: number;
  /** Tool that produced the output, e.g. `bash`. */
  name: string;
  /** Human title, e.g. `npm test`. */
  title: string;
  /** The complete, untruncated body. */
  body: string;
  /** Whether the block is currently shown expanded. */
  expanded: boolean;
}

/** How many folds to keep. Older ones are dropped; the transcript still shows
 * their collapsed form, only the ability to re-expand them is lost. */
const MAX_FOLDS = 100;

class FoldStore {
  private readonly folds: Fold[] = [];
  private nextId = 1;

  /** Records a body that was printed collapsed and returns its handle. */
  add(name: string, title: string, body: string): Fold {
    const fold: Fold = { id: this.nextId++, name, title, body, expanded: false };
    this.folds.push(fold);
    if (this.folds.length > MAX_FOLDS) this.folds.shift();
    return fold;
  }

  get(id: number): Fold | undefined {
    return this.folds.find((fold) => fold.id === id);
  }

  /** The most recent fold, which is what `Ctrl+O` acts on. */
  last(): Fold | undefined {
    return this.folds[this.folds.length - 1];
  }

  /** Flips a fold's state and returns it, or undefined when it is unknown. */
  toggle(id?: number): Fold | undefined {
    const fold = id === undefined ? this.last() : this.get(id);
    if (fold === undefined) return undefined;
    fold.expanded = !fold.expanded;
    return fold;
  }

  /** Number of folds still held, for tests. */
  size(): number {
    return this.folds.length;
  }

  reset(): void {
    this.folds.length = 0;
    this.nextId = 1;
  }
}

const store = new FoldStore();

/** The process-wide fold store. */
export function folds(): FoldStore {
  return store;
}
