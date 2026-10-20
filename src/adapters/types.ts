/** Generic wallet adapter interface for signing Stellar transactions. */
export interface WalletAdapter {
  /** Return the wallet's public key (G... address). */
  getAddress(): Promise<string>;
  /**
   * Sign a transaction XDR string.
   *
   * @param xdr     - Base64-encoded transaction XDR.
   * @param network - Network passphrase.
   * @returns Signed transaction XDR.
   */
  signTransaction(xdr: string, network: string): Promise<string>;
}

/** Supported source chains for the cross-chain payment bridge. */
export type BridgeSourceChain = 'ethereum' | 'solana';

/** Lifecycle status of a cross-chain bridge transfer. */
export type BridgeTransferStatus =
  | 'pending'
  | 'source-confirmed'
  | 'bridging'
  | 'stellar-confirmed'
  | 'completed'
  | 'failed';

/** Parameters for initiating an Ethereum/Solana -> Stellar bridge transfer. */
export interface BridgeTransferParams {
  /** Source chain the funds are bridged from. */
  sourceChain: BridgeSourceChain;
  /** Address on the source chain sending the funds. */
  sourceAddress: string;
  /** Stellar (G...) address receiving the bridged funds. */
  destinationAddress: string;
  /** Amount to bridge, as a decimal string in the source asset's units. */
  amount: string;
  /** Optional source-chain asset identifier (e.g. ERC-20 / SPL mint). */
  sourceAsset?: string;
  /** Optional Stellar asset to receive (defaults to the bridged asset). */
  destinationAsset?: string;
}

/** A cross-chain bridge transfer record. */
export interface BridgeTransfer {
  /** Unique bridge transfer identifier. */
  id: string;
  /** Current lifecycle status. */
  status: BridgeTransferStatus;
  /** Parameters the transfer was initiated with. */
  params: BridgeTransferParams;
  /** Source-chain transaction hash, once submitted. */
  sourceTxHash?: string;
  /** Stellar transaction hash, once submitted. */
  stellarTxHash?: string;
  /** Error message when the transfer fails. */
  error?: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Last update timestamp (ms since epoch). */
  updatedAt: number;
}

/** Bridge lifecycle events emitted to subscribers. */
export type BridgeEvent =
  | { type: 'transfer-created'; transfer: BridgeTransfer }
  | { type: 'status-changed'; transfer: BridgeTransfer; previousStatus: BridgeTransferStatus }
  | { type: 'source-confirmed'; transfer: BridgeTransfer; sourceTxHash: string }
  | { type: 'stellar-confirmed'; transfer: BridgeTransfer; stellarTxHash: string }
  | { type: 'completed'; transfer: BridgeTransfer }
  | { type: 'failed'; transfer: BridgeTransfer; error: string };

/** Listener invoked for each emitted bridge event. */
export type BridgeEventListener = (event: BridgeEvent) => void;

/**
 * Cross-chain payment bridge client for moving funds from Ethereum/Solana to Stellar.
 */
export interface BridgeClient {
  /** Initiate a bridge transfer and return its initial record. */
  initiateTransfer(params: BridgeTransferParams): Promise<BridgeTransfer>;
  /** Fetch the current state of a bridge transfer by id. */
  getTransfer(id: string): Promise<BridgeTransfer | undefined>;
  /** List all known bridge transfers. */
  listTransfers(): Promise<BridgeTransfer[]>;
  /** Subscribe to bridge lifecycle events; returns an unsubscribe function. */
  onEvent(listener: BridgeEventListener): () => void;
}

/** Supported sidechain networks for scalable off-main-chain settlement. */
export type SidechainNetwork = 'polygon' | 'arbitrum' | 'optimism';

/** Lifecycle status of an atomic swap between the main chain and a sidechain. */
export type AtomicSwapStatus =
  | 'initiated'
  | 'counterparty-locked'
  | 'completed'
  | 'refunded'
  | 'failed';

/** Parameters for initiating an atomic swap across chains. */
export interface AtomicSwapParams {
  /** Sidechain the swap settles on. */
  sidechain: SidechainNetwork;
  /** Address on the main chain locking funds. */
  initiatorAddress: string;
  /** Address on the sidechain receiving the swapped funds. */
  counterpartyAddress: string;
  /** Amount to swap, as a decimal string. */
  amount: string;
  /** Optional asset identifier being swapped. */
  asset?: string;
  /** Hash of the secret used for the hash-time-locked contract. */
  secretHash: string;
  /** Unix timestamp (ms) after which the swap may be refunded. */
  timeoutAt: number;
}

/** An atomic swap record tracking the initiate/complete/refund lifecycle. */
export interface AtomicSwap {
  /** Unique atomic swap identifier. */
  id: string;
  /** Current lifecycle status. */
  status: AtomicSwapStatus;
  /** Parameters the swap was initiated with. */
  params: AtomicSwapParams;
  /** Main-chain lock transaction hash, once submitted. */
  mainChainTxHash?: string;
  /** Sidechain lock transaction hash, once submitted. */
  sidechainTxHash?: string;
  /** Error message when the swap fails. */
  error?: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Last update timestamp (ms since epoch). */
  updatedAt: number;
}

/** Result of validating a cross-chain bridge transfer before submission. */
export interface BridgeValidationResult {
  /** Whether the transfer passed all validation checks. */
  valid: boolean;
  /** Human-readable reasons for any failed checks. */
  errors: string[];
}

/** Snapshot of synchronized state between the main chain and a sidechain. */
export interface SidechainStateSnapshot {
  /** Sidechain the snapshot belongs to. */
  sidechain: SidechainNetwork;
  /** Latest synchronized block height on the sidechain. */
  blockHeight: number;
  /** Hash of the last synchronized state root. */
  stateRoot: string;
  /** Whether the local view is in sync with the sidechain head. */
  synced: boolean;
  /** Snapshot timestamp (ms since epoch). */
  updatedAt: number;
}

/** Aggregated analytics for sidechain usage and scalability. */
export interface SidechainAnalytics {
  /** Total number of bridge transfers observed. */
  totalTransfers: number;
  /** Total number of atomic swaps observed. */
  totalSwaps: number;
  /** Number of transfers/swaps that completed successfully. */
  completedCount: number;
  /** Number of transfers/swaps that failed or were refunded. */
  failedCount: number;
  /** Total value moved across the sidechain, as a decimal string. */
  totalVolume: string;
  /** Average settlement latency in milliseconds. */
  averageLatencyMs: number;
}

/** Sidechain lifecycle events emitted to subscribers. */
export type SidechainEvent =
  | { type: 'swap-initiated'; swap: AtomicSwap }
  | { type: 'swap-completed'; swap: AtomicSwap }
  | { type: 'swap-refunded'; swap: AtomicSwap }
  | { type: 'bridge-validated'; result: BridgeValidationResult }
  | { type: 'state-synced'; snapshot: SidechainStateSnapshot }
  | { type: 'analytics-updated'; analytics: SidechainAnalytics };

/** Listener invoked for each emitted sidechain event. */
export type SidechainEventListener = (event: SidechainEvent) => void;

/**
 * Sidechain adapter for scalable cross-chain settlement.
 *
 * Provides atomic swaps, bridge validation, state synchronization, and
 * analytics for moving value between the main chain and a sidechain.
 */
export interface SidechainAdapter {
  /** Initiate an atomic swap and return its initial record. */
  initiateSwap(params: AtomicSwapParams): Promise<AtomicSwap>;
  /** Complete an atomic swap by revealing the preimage of the secret hash. */
  completeSwap(id: string, secret: string): Promise<AtomicSwap>;
  /** Refund an expired atomic swap back to the initiator. */
  refundSwap(id: string): Promise<AtomicSwap>;
  /** Fetch the current state of an atomic swap by id. */
  getSwap(id: string): Promise<AtomicSwap | undefined>;
  /** Validate a bridge transfer before it is submitted. */
  validateBridgeTransfer(params: BridgeTransferParams): Promise<BridgeValidationResult>;
  /** Synchronize local state with the sidechain head. */
  syncState(sidechain: SidechainNetwork): Promise<SidechainStateSnapshot>;
  /** Retrieve aggregated sidechain analytics. */
  getAnalytics(): Promise<SidechainAnalytics>;
  /** Subscribe to sidechain lifecycle events; returns an unsubscribe function. */
  onEvent(listener: SidechainEventListener): () => void;
}

/** A single operation to include in a multi-op invoice transaction. */
export interface InvoiceOperation {
  /** Operation kind (e.g. 'payment', 'create-account', 'change-trust'). */
  type: string;
  /** Operation-specific parameters. */
  params: Record<string, unknown>;
  /** Optional human-readable description of the operation. */
  description?: string;
}

/** Parameters for building a complex multi-op invoice transaction. */
export interface InvoiceTransactionParams {
  /** Stellar (G...) address funding the transaction. */
  sourceAddress: string;
  /** Network passphrase the transaction targets. */
  network: string;
  /** Optional memo attached to the transaction. */
  memo?: string;
  /** Ordered operations composing the invoice. */
  operations: InvoiceOperation[];
}

/** A built, unsigned multi-op invoice transaction. */
export interface InvoiceTransaction {
  /** Base64-encoded unsigned transaction XDR. */
  xdr: string;
  /** Source account the transaction was built from. */
  sourceAddress: string;
  /** Network passphrase the transaction targets. */
  network: string;
  /** Operations included in the transaction, in order. */
  operations: InvoiceOperation[];
  /** Optional memo attached to the transaction. */
  memo?: string;
  /** Build timestamp (ms since epoch). */
  createdAt: number;
}

/** Lifecycle events emitted by the invoice transaction builder. */
export type InvoiceTransactionEvent =
  | { type: 'build-started'; params: InvoiceTransactionParams }
  | { type: 'operation-added'; operation: InvoiceOperation; index: number }
  | { type: 'build-completed'; transaction: InvoiceTransaction }
  | { type: 'build-failed'; error: string };

/** Listener invoked for each emitted invoice transaction event. */
export type InvoiceTransactionEventListener = (event: InvoiceTransactionEvent) => void;

/**
 * Builder for composing complex multi-op invoice transactions.
 */
export interface InvoiceTransactionBuilder {
  /** Append an operation to the invoice. */
  addOperation(operation: InvoiceOperation): InvoiceTransactionBuilder;
  /** Build the unsigned transaction from the accumulated operations. */
  build(): Promise<InvoiceTransaction>;
  /** Subscribe to builder lifecycle events; returns an unsubscribe function. */
  onEvent(listener: InvoiceTransactionEventListener): () => void;
}

/**
 * Configuration for optional request deduplication by nonce.
 *
 * Deduplication is opt-in: when omitted (or `enabled` is false) requests
 * pass through unchanged and no nonce tracking occurs.
 */
export interface DeduplicationConfig {
  /** Whether deduplication is enabled. Defaults to false. */
  enabled?: boolean;
  /**
   * Time-to-live for a tracked nonce, in milliseconds. Once a nonce has been
   * seen for longer than this window it is evicted and may be accepted again.
   * When omitted, entries do not expire by time.
   */
  ttlMs?: number;
  /**
   * Maximum number of nonces retained. When exceeded, the oldest entries are
   * evicted first (FIFO). When omitted, capacity is unbounded.
   */
  maxEntries?: number;
}

/** Outcome of a deduplication check for a single request nonce. */
export type DeduplicationOutcome = 'accepted' | 'duplicate';

/** Lifecycle events emitted by the request deduplicator. */
export type DeduplicationEvent =
  | { type: 'request-accepted'; nonce: string }
  | { type: 'duplicate-detected'; nonce: string }
  | { type: 'nonce-evicted'; nonce: string; reason: 'expired' | 'capacity' };

/** Listener invoked for each emitted deduplication event. */
export type DeduplicationEventListener = (event: DeduplicationEvent) => void;

/**
 * Optional request deduplicator keyed by nonce.
 *
 * Implementations track previously seen nonces and report whether an incoming
 * request is a first-seen (accepted) or duplicate request.
 */
export interface RequestDeduplicator {
  /**
   * Check a nonce and record it when first seen.
   *
   * @param nonce - Unique request nonce.
   * @returns 'accepted' for a first-seen nonce, 'duplicate' otherwise.
   */
  check(nonce: string): DeduplicationOutcome;
  /** Whether the given nonce is currently tracked. */
  has(nonce: string): boolean;
  /** Remove all tracked nonces. */
  clear(): void;
  /** Subscribe to deduplication events; returns an unsubscribe function. */
  onEvent(listener: DeduplicationEventListener): () => void;
}
