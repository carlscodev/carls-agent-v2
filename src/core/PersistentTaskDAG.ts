import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A task graph that survives the process.
 *
 * A long refactor is not one conversation, it is several: the terminal closes, the
 * laptop sleeps, a test run takes ten minutes and the user starts something else.
 * An in-memory plan loses all of that, and the agent restarts by re-deriving what
 * it already knew — or worse, by asking the human to repeat the brief.
 *
 * The graph is written to `.carls/state/dag.json` after every transition, so
 * "resume" is reading a file, not replaying a transcript. Nodes carry an
 * acceptance criterion and the checkpoint that preceded them, which is what makes
 * a rollback land somewhere meaningful rather than at the start.
 */

export type NodeStatus = "pending" | "running" | "verifying" | "completed" | "failed" | "rolled_back";

export interface DagNode {
  id: string;
  title: string;
  /** Node ids that must be `completed` before this one may start. */
  dependencies: string[];
  status: NodeStatus;
  /** What must be true for this node to count as done. */
  acceptanceCriteria: string;
  /** Files the node is expected to touch, used for language-server verification. */
  files: string[];
  /** Commands that define success for this node. */
  verifyCommands: string[];
  /** ShadowGit checkpoint taken before the node started. */
  checkpointId?: string;
  retryCount: number;
  /** Why the node failed, kept so the agent does not repeat the same attempt. */
  lastError?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DagSnapshot {
  objective: string;
  createdAt: string;
  updatedAt: string;
  nodes: DagNode[];
  completed: number;
  failed: number;
  pending: number;
  /** True when every node is completed. */
  done: boolean;
}

export interface DagNodeInput {
  id?: string | undefined;
  title: string;
  dependencies?: string[] | undefined;
  acceptanceCriteria?: string | undefined;
  files?: string[] | undefined;
  verifyCommands?: string[] | undefined;
}

export class DagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagError";
  }
}

const STATE_VERSION = 1;

interface StateFile {
  version: number;
  objective: string;
  createdAt: string;
  updatedAt: string;
  nodes: DagNode[];
}

export class PersistentTaskDAG {
  private readonly path: string;
  private objective: string;
  private createdAt: string;
  private nodes: DagNode[];
  private counter = 0;
  /** Push notification for the TUI; never used by the graph's own logic. */
  private observer?: (snapshot: DagSnapshot) => void;

  constructor(stateDir: string, objective = "", nodes: DagNode[] = [], createdAt?: string) {
    this.path = join(stateDir, "dag.json");
    this.objective = objective;
    this.createdAt = createdAt ?? new Date().toISOString();
    this.nodes = nodes;
    for (const node of nodes) {
      const numeric = Number.parseInt(node.id.replace(/^n/, ""), 10);
      if (Number.isFinite(numeric) && numeric > this.counter) this.counter = numeric;
    }
  }

  /** Path of the persisted file, for `/dag` and the receipt. */
  get statePath(): string {
    return this.path;
  }

  /** Subscribes the UI to every transition; passing undefined detaches it. */
  setObserver(observer?: (snapshot: DagSnapshot) => void): void {
    if (observer === undefined) delete this.observer;
    else this.observer = observer;
  }

  /**
   * Loads a graph from disk, or returns undefined when there is none.
   *
   * A corrupt or older-version file is ignored rather than repaired: the plan is
   * recoverable from the user, and guessing at a half-written JSON is not.
   */
  static load(stateDir: string): PersistentTaskDAG | undefined {
    const path = join(stateDir, "dag.json");
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile>;
      if (parsed.version !== STATE_VERSION) return undefined;
      if (typeof parsed.objective !== "string" || !Array.isArray(parsed.nodes)) return undefined;
      return new PersistentTaskDAG(stateDir, parsed.objective, parsed.nodes as DagNode[], parsed.createdAt);
    } catch {
      return undefined;
    }
  }

  /** Removes the persisted file, so a finished plan does not auto-resume. */
  static clear(stateDir: string): void {
    const path = join(stateDir, "dag.json");
    if (existsSync(path)) {
      try {
        writeFileSync(path, "", "utf8");
      } catch {
        // Best effort: an unwritable state dir must not break a session.
      }
    }
  }

  /** Replaces the plan. Used when the router decomposes an objective. */
  plan(objective: string, inputs: readonly DagNodeInput[]): void {
    if (inputs.length === 0) throw new DagError("A plan needs at least one node.");
    this.objective = objective;
    this.createdAt = new Date().toISOString();
    this.counter = 0;
    this.nodes = inputs.map((input) => this.materialize(input));
    this.validate();
    this.persist();
  }

  private materialize(input: DagNodeInput): DagNode {
    this.counter += 1;
    const id = input.id ?? `n${this.counter}`;
    const node: DagNode = {
      id,
      title: input.title,
      dependencies: input.dependencies ?? [],
      status: "pending",
      acceptanceCriteria: input.acceptanceCriteria ?? "",
      files: input.files ?? [],
      verifyCommands: input.verifyCommands ?? [],
      retryCount: 0,
    };
    return node;
  }

  /** Appends one node, which is how the agent extends a plan it under-scoped. */
  add(input: DagNodeInput): DagNode {
    const node = this.materialize(input);
    if (this.nodes.some((existing) => existing.id === node.id)) {
      throw new DagError(`Node id "${node.id}" already exists.`);
    }
    this.nodes.push(node);
    this.validate();
    this.persist();
    return node;
  }

  /**
   * Rejects a graph that cannot run: a dependency on a missing node, or a cycle.
   * Catching it at plan time is much cheaper than discovering it when a node
   * waits forever for a prerequisite that will never complete.
   */
  private validate(): void {
    const ids = new Set(this.nodes.map((node) => node.id));
    for (const node of this.nodes) {
      for (const dependency of node.dependencies) {
        if (!ids.has(dependency)) {
          throw new DagError(`Node "${node.id}" depends on "${dependency}", which does not exist.`);
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(this.nodes.map((node) => [node.id, node]));
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new DagError(`Dependency cycle detected at node "${id}".`);
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const node of this.nodes) visit(node.id);
  }

  all(): DagNode[] {
    return this.nodes;
  }

  get(id: string): DagNode | undefined {
    return this.nodes.find((node) => node.id === id);
  }

  /**
   * The next node to work on: the first pending node whose dependencies are all
   * completed. Returns undefined when nothing is runnable, which is either
   * "done" or "blocked", and the caller distinguishes those with `snapshot`.
   */
  next(): DagNode | undefined {
    return this.nodes.find(
      (node) =>
        node.status === "pending" &&
        node.dependencies.every((dependency) => this.get(dependency)?.status === "completed"),
    );
  }

  /** True when every node reached `completed`. */
  get done(): boolean {
    return this.nodes.length > 0 && this.nodes.every((node) => node.status === "completed");
  }

  /**
   * True when nothing is runnable and something is unfinished.
   *
   * A node that is `running` or `verifying` counts as progress, not as a block:
   * reporting a plan as blocked while work is actively happening would push the
   * agent to intervene in a node that is about to succeed. "Blocked" is reserved
   * for the state that genuinely needs a decision — a failed node, or a dependency
   * that will never complete.
   */
  get blocked(): boolean {
    if (this.done) return false;
    if (this.nodes.some((node) => node.status === "running" || node.status === "verifying")) return false;
    return this.next() === undefined;
  }

  /**
   * Moves a node into a new status, refusing illegal transitions.
   *
   * The transition table is what keeps a half-finished node from being marked
   * complete by a careless caller: a node must pass through `verifying`, and a
   * rollback is recorded as such rather than silently returning to pending.
   */
  setStatus(id: string, status: NodeStatus, detail?: string): DagNode {
    const node = this.get(id);
    if (node === undefined) throw new DagError(`Unknown node "${id}".`);

    const allowed: Record<NodeStatus, NodeStatus[]> = {
      pending: ["running", "rolled_back"],
      running: ["verifying", "failed", "rolled_back"],
      verifying: ["completed", "failed", "rolled_back"],
      completed: [],
      failed: ["running", "rolled_back"],
      rolled_back: ["pending"],
    };
    if (!allowed[node.status].includes(status)) {
      throw new DagError(`Illegal transition for "${id}": ${node.status} -> ${status}.`);
    }

    node.status = status;
    const now = new Date().toISOString();
    if (status === "running") {
      node.startedAt = now;
      node.retryCount += 1;
    }
    if (status === "completed" || status === "failed" || status === "rolled_back") node.finishedAt = now;
    if (status === "failed" && detail !== undefined) node.lastError = detail;
    if (status === "completed") delete node.lastError;

    this.persist();
    return node;
  }

  /** Records the checkpoint taken before a node's work started. */
  attachCheckpoint(id: string, checkpointId: string): void {
    const node = this.get(id);
    if (node === undefined) throw new DagError(`Unknown node "${id}".`);
    node.checkpointId = checkpointId;
    this.persist();
  }

  /** Resets a failed node so a new attempt may start. */
  retry(id: string): DagNode {
    const node = this.get(id);
    if (node === undefined) throw new DagError(`Unknown node "${id}".`);
    if (node.status !== "failed") throw new DagError(`Node "${id}" is ${node.status}, not failed.`);
    return this.setStatus(id, "running");
  }

  snapshot(): DagSnapshot {
    const completed = this.nodes.filter((node) => node.status === "completed").length;
    const failed = this.nodes.filter((node) => node.status === "failed" || node.status === "rolled_back").length;
    const pending = this.nodes.filter((node) => node.status === "pending").length;
    return {
      objective: this.objective,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      nodes: this.nodes.map((node) => ({ ...node })),
      completed,
      failed,
      pending,
      done: this.done,
    };
  }

  /**
   * Writes through a temporary file and renames it into place, so a crash
   * mid-write leaves the previous plan intact rather than a truncated JSON.
   */
  private persist(): void {
    const file: StateFile = {
      version: STATE_VERSION,
      objective: this.objective,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      nodes: this.nodes,
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      renameSync(temporary, this.path);
    } catch {
      // A read-only workspace must not break the plan; it just will not resume.
    }
    // Publish even when the write failed: the in-memory plan did change, and a
    // HUD that only updates on a writable disk would lie about the real state.
    this.observer?.(this.snapshot());
  }
}
