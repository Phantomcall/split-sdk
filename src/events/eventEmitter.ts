/**
 * Typed event emitter for state changes and transaction lifecycle events.
 *
 * Supports synchronous and asynchronous handlers, one-shot listeners,
 * event filtering, and safe deregistration without leaking listeners.
 */

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export type EventFilter<T = unknown> = (payload: T) => boolean;

export interface ListenerOptions<T = unknown> {
  /** Only invoke the handler when the filter returns true. */
  filter?: EventFilter<T>;
  /** Remove the listener after the first invocation. */
  once?: boolean;
}

export interface TransactionEvent {
  hash: string;
  status: TransactionStatus;
  timestamp: number;
  error?: Error;
}

export type TransactionStatus = 'submitted' | 'confirmed' | 'failed';

export interface StateChangeEvent<T = unknown> {
  key: string;
  previous: T | undefined;
  current: T;
  timestamp: number;
}

export interface EventMap {
  'transaction:submitted': TransactionEvent;
  'transaction:confirmed': TransactionEvent;
  'transaction:failed': TransactionEvent;
  'state:change': StateChangeEvent;
  [event: string]: unknown;
}

interface RegisteredListener {
  handler: EventHandler<never>;
  filter?: EventFilter<never>;
  once: boolean;
}

export class EventEmitter {
  private listeners = new Map<string, Set<RegisteredListener>>();

  /**
   * Register a listener for an event. Returns an unsubscribe function.
   */
  on<K extends keyof EventMap>(
    event: K,
    handler: EventHandler<EventMap[K]>,
    options: ListenerOptions<EventMap[K]> = {},
  ): () => void {
    return this.addListener(event as string, handler, options);
  }

  /**
   * Register a listener that is removed after its first invocation.
   */
  once<K extends keyof EventMap>(
    event: K,
    handler: EventHandler<EventMap[K]>,
    options: Omit<ListenerOptions<EventMap[K]>, 'once'> = {},
  ): () => void {
    return this.addListener(event as string, handler, { ...options, once: true });
  }

  /**
   * Remove a previously registered listener.
   */
  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    const set = this.listeners.get(event as string);
    if (!set) return;
    for (const listener of set) {
      if (listener.handler === handler) {
        set.delete(listener);
      }
    }
    if (set.size === 0) {
      this.listeners.delete(event as string);
    }
  }

  /**
   * Emit an event to all matching listeners. Async handlers are awaited
   * when `await`ed by the caller; errors in one handler do not prevent
   * others from running.
   */
  async emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): Promise<void> {
    const set = this.listeners.get(event as string);
    if (!set || set.size === 0) return;

    // Snapshot so listeners added/removed during emit don't affect this run.
    const snapshot = Array.from(set);
    const pending: Promise<void>[] = [];

    for (const listener of snapshot) {
      if (listener.filter && !listener.filter(payload as never)) {
        continue;
      }
      if (listener.once) {
        set.delete(listener);
      }
      try {
        const result = listener.handler(payload as never);
        if (result && typeof (result as Promise<void>).then === 'function') {
          pending.push(
            (result as Promise<void>).catch((err) => {
              this.reportHandlerError(event as string, err);
            }),
          );
        }
      } catch (err) {
        this.reportHandlerError(event as string, err);
      }
    }

    if (set.size === 0) {
      this.listeners.delete(event as string);
    }

    if (pending.length > 0) {
      await Promise.all(pending);
    }
  }

  /**
   * Remove all listeners, optionally scoped to a single event.
   */
  removeAllListeners<K extends keyof EventMap>(event?: K): void {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event as string);
    }
  }

  /**
   * Number of listeners registered for an event (or all events).
   */
  listenerCount<K extends keyof EventMap>(event?: K): number {
    if (event === undefined) {
      let total = 0;
      for (const set of this.listeners.values()) total += set.size;
      return total;
    }
    return this.listeners.get(event as string)?.size ?? 0;
  }

  private addListener<K>(
    event: string,
    handler: EventHandler<K>,
    options: ListenerOptions<K>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const listener: RegisteredListener = {
      handler: handler as EventHandler<never>,
      filter: options.filter as EventFilter<never> | undefined,
      once: options.once ?? false,
    };
    set.add(listener);
    return () => {
      const current = this.listeners.get(event);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  private reportHandlerError(event: string, err: unknown): void {
    // Surface handler failures without breaking other listeners.
    // eslint-disable-next-line no-console
    console.error(`[EventEmitter] handler for "${event}" failed:`, err);
  }
}

export const eventEmitter = new EventEmitter();
