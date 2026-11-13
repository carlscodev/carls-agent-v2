import type { DagSnapshot } from "./PersistentTaskDAG.js";

/**
 * A low-latency, strongly typed event bus.
 *
 * The TUI used to learn about a turn by being called back through five separate
 * options, which is fine for one renderer and hostile to a second one: every new
 * panel meant another parameter on `AgentLoop.run`. The bus lets the core publish
 * facts (`tool.start`, `stream.delta`, `dag.updated`) and lets any number of
 * views subscribe without the core importing a renderer.
 *
 * Delivery is synchronous and allocation-light: `emit` walks a `Set` and does
 * nothing at all when the event has no listeners. That is the whole point of a
 * push bus — no timer, no polling, no frame budget spent diffing state that did
 * not change.
 */

export interface TurnStartEvent {
  goal: string;
  sessionId: string;
  at: number;
}

export interface TurnEndEvent {
  goal: string;
  stoppedReason: string;
  steps: number;
  durationMs: number;
  at: number;
}

export interface StreamDeltaEvent {
  kind: "text" | "reasoning";
  text: string;
  at: number;
}

export interface ToolStartEvent {
  id: string;
  name: string;
  input: unknown;
  at: number;
}

export interface ToolProgressEvent {
  id: string;
  name: string;
  message: string;
  at: number;
}

export interface ToolDoneEvent {
  id: string;
  name: string;
  ok: boolean;
  durationMs: number;
  at: number;
}

export interface DagUpdatedEvent {
  snapshot: DagSnapshot;
  at: number;
}

export interface CompactionLayerEvent {
  layer: number;
  applied: boolean;
  tokensBefore: number;
  tokensAfter: number;
  at: number;
}

export interface SteerQueuedEvent {
  text: string;
  depth: number;
  at: number;
}

export interface SubAgentStatusEvent {
  role: string;
  goal: string;
  phase: "start" | "done" | "failed";
  ok?: boolean;
  at: number;
}

export interface CarlsEventMap {
  "turn.start": TurnStartEvent;
  "turn.end": TurnEndEvent;
  "stream.delta": StreamDeltaEvent;
  "tool.start": ToolStartEvent;
  "tool.progress": ToolProgressEvent;
  "tool.done": ToolDoneEvent;
  "dag.updated": DagUpdatedEvent;
  "compaction.layer": CompactionLayerEvent;
  "steer.queued": SteerQueuedEvent;
  "subagent.status": SubAgentStatusEvent;
}

export type CarlsEventName = keyof CarlsEventMap;

export type EventHandler<K extends CarlsEventName> = (payload: CarlsEventMap[K]) => void;

type UntypedHandler = (payload: unknown) => void;

export class EventBus {
  private readonly handlers = new Map<CarlsEventName, Set<UntypedHandler>>();
  private readonly onError?: (error: unknown) => void;

  constructor(options: { onError?: (error: unknown) => void } = {}) {
    if (options.onError !== undefined) this.onError = options.onError;
  }

  /**
   * Subscribes and returns the unsubscribe function. Returning it instead of a
   * subscription object keeps call sites short and makes cleanup a one-liner.
   */
  on<K extends CarlsEventName>(name: K, handler: EventHandler<K>): () => void {
    let bucket = this.handlers.get(name);
    if (bucket === undefined) {
      bucket = new Set<UntypedHandler>();
      this.handlers.set(name, bucket);
    }
    const wrapped = handler as UntypedHandler;
    bucket.add(wrapped);
    return () => this.off(name, handler);
  }

  /** Fires once and unsubscribes itself before the handler runs. */
  once<K extends CarlsEventName>(name: K, handler: EventHandler<K>): () => void {
    const off = this.on(name, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends CarlsEventName>(name: K, handler: EventHandler<K>): void {
    const bucket = this.handlers.get(name);
    if (bucket === undefined) return;
    bucket.delete(handler as UntypedHandler);
    if (bucket.size === 0) this.handlers.delete(name);
  }

  /**
   * Publishes synchronously. A throwing subscriber is isolated: one broken
   * panel must not abort a turn or starve the other subscribers.
   */
  emit<K extends CarlsEventName>(name: K, payload: CarlsEventMap[K]): void {
    const bucket = this.handlers.get(name);
    if (bucket === undefined || bucket.size === 0) return;
    // Snapshot so a handler that unsubscribes itself cannot skip its neighbour.
    for (const handler of [...bucket]) {
      try {
        handler(payload);
      } catch (error) {
        this.onError?.(error);
      }
    }
  }

  /** Removes every listener, or every listener for one event. */
  clear(name?: CarlsEventName): void {
    if (name === undefined) this.handlers.clear();
    else this.handlers.delete(name);
  }

  listenerCount(name?: CarlsEventName): number {
    if (name !== undefined) return this.handlers.get(name)?.size ?? 0;
    let total = 0;
    for (const bucket of this.handlers.values()) total += bucket.size;
    return total;
  }
}
