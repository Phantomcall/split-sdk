import { EventEmitter } from "./events/eventEmitter";
import type { EventMap } from "./events/types";

export type TransactionStep =
  | "created"
  | "simulated"
  | "signed"
  | "submitted"
  | "confirmed"
  | "error";

export interface TransactionEventBase {
  transactionId: string;
  step: TransactionStep;
  timestamp: number;
}

export interface TransactionCreatedEvent extends TransactionEventBase {
  step: "created";
  operation: string;
  sourceAccount?: string;
  details?: Record<string, unknown>;
}

export interface TransactionSimulatedEvent extends TransactionEventBase {
  step: "simulated";
  success: boolean;
  fee?: string;
  result?: unknown;
}

export interface TransactionSignedEvent extends TransactionEventBase {
  step: "signed";
  signer?: string;
  signatureCount?: number;
}

export interface TransactionSubmittedEvent extends TransactionEventBase {
  step: "submitted";
  hash?: string;
  ledger?: number;
}

export interface TransactionConfirmedEvent extends TransactionEventBase {
  step: "confirmed";
  success: boolean;
  hash?: string;
  ledger?: number;
  result?: unknown;
}

export interface TransactionErrorEvent extends TransactionEventBase {
  step: "error";
  failedStep: Exclude<TransactionStep, "error">;
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export type TransactionEvent =
  | TransactionCreatedEvent
  | TransactionSimulatedEvent
  | TransactionSignedEvent
  | TransactionSubmittedEvent
  | TransactionConfirmedEvent
  | TransactionErrorEvent;

export interface TransactionEventMap extends EventMap {
  "transaction:created": TransactionCreatedEvent;
  "transaction:simulated": TransactionSimulatedEvent;
  "transaction:signed": TransactionSignedEvent;
  "transaction:submitted": TransactionSubmittedEvent;
  "transaction:confirmed": TransactionConfirmedEvent;
  "transaction:error": TransactionErrorEvent;
}

export type TransactionEventListener = (event: TransactionEvent) => void;

const EVENT_NAME_BY_STEP: Record<TransactionStep, keyof TransactionEventMap> = {
  created: "transaction:created",
  simulated: "transaction:simulated",
  signed: "transaction:signed",
  submitted: "transaction:submitted",
  confirmed: "transaction:confirmed",
  error: "transaction:error",
};

/**
 * Tracks and emits detailed events for each transaction step so the UI can
 * follow transaction progress from creation through confirmation.
 */
export class TransactionEventTracker {
  private readonly emitter: EventEmitter;
  private readonly listeners = new Set<TransactionEventListener>();

  constructor(emitter: EventEmitter = new EventEmitter()) {
    this.emitter = emitter;
  }

  /** Subscribe to every transaction event. Returns an unsubscribe function. */
  subscribe(listener: TransactionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: TransactionEvent): void {
    const name = EVENT_NAME_BY_STEP[event.step];
    this.emitter.emit(name, event as TransactionEventMap[typeof name]);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  emitCreated(
    transactionId: string,
    operation: string,
    extra: { sourceAccount?: string; details?: Record<string, unknown> } = {},
  ): TransactionCreatedEvent {
    const event: TransactionCreatedEvent = {
      transactionId,
      step: "created",
      timestamp: Date.now(),
      operation,
      ...extra,
    };
    this.emit(event);
    return event;
  }

  emitSimulated(
    transactionId: string,
    result: { success: boolean; fee?: string; result?: unknown },
  ): TransactionSimulatedEvent {
    const event: TransactionSimulatedEvent = {
      transactionId,
      step: "simulated",
      timestamp: Date.now(),
      ...result,
    };
    this.emit(event);
    return event;
  }

  emitSigned(
    transactionId: string,
    extra: { signer?: string; signatureCount?: number } = {},
  ): TransactionSignedEvent {
    const event: TransactionSignedEvent = {
      transactionId,
      step: "signed",
      timestamp: Date.now(),
      ...extra,
    };
    this.emit(event);
    return event;
  }

  emitSubmitted(
    transactionId: string,
    extra: { hash?: string; ledger?: number } = {},
  ): TransactionSubmittedEvent {
    const event: TransactionSubmittedEvent = {
      transactionId,
      step: "submitted",
      timestamp: Date.now(),
      ...extra,
    };
    this.emit(event);
    return event;
  }

  emitConfirmed(
    transactionId: string,
    result: { success: boolean; hash?: string; ledger?: number; result?: unknown },
  ): TransactionConfirmedEvent {
    const event: TransactionConfirmedEvent = {
      transactionId,
      step: "confirmed",
      timestamp: Date.now(),
      ...result,
    };
    this.emit(event);
    return event;
  }

  emitError(
    transactionId: string,
    failedStep: Exclude<TransactionStep, "error">,
    error: { message: string; code?: string; details?: unknown },
  ): TransactionErrorEvent {
    const event: TransactionErrorEvent = {
      transactionId,
      step: "error",
      timestamp: Date.now(),
      failedStep,
      error,
    };
    this.emit(event);
    return event;
  }
}
