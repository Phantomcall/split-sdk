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
  /** Aggregate usage analytics for a sidechain. */
  getAnalytics(sidechain: SidechainNetwork): Promise<SidechainAnalytics>;
  /** Subscribe to sidechain lifecycle events; returns an unsubscribe function. */
  onEvent(listener: SidechainEventListener): () => void;
}

/** Supported rollup protocols for batching and cost reduction. */
export type RollupProtocol = 'optimistic' | 'zk';

/** Lifecycle status of a rollup batch. */
export type RollupBatchStatus =
  | 'pending'
  | 'submitted'
  | 'proven'
  | 'settled'
  | 'failed';

/** A single transaction included in a rollup batch. */
export interface RollupTransaction {
  /** Unique transaction identifier within the batch. */
  id: string;
  /** Sender address. */
  from: string;
  /** Recipient address. */
  to: string;
  /** Amount to transfer, as a decimal string. */
  amount: string;
  /** Optional asset identifier being transferred. */
  asset?: string;
  /** Optional calldata / memo attached to the transaction. */
  data?: string;
}

/** Parameters for creating a rollup batch. */
export interface RollupBatchParams {
  /** Rollup protocol the batch is submitted to. */
  protocol: RollupProtocol;
  /** Transactions to include in the batch. */
  transactions: RollupTransaction[];
  /** Optional maximum number of transactions per batch. */
  maxBatchSize?: number;
}

/** A rollup batch record tracking the submit/prove/settle lifecycle. */
export interface RollupBatch {
  /** Unique rollup batch identifier. */
  id: string;
  /** Rollup protocol the batch is submitted to. */
  protocol: RollupProtocol;
  /** Current lifecycle status. */
  status: RollupBatchStatus;
  /** Transactions included in the batch. */
  transactions: RollupTransaction[];
  /** Hash committing to the batch contents. */
  batchHash: string;
  /** Proof generated for the batch, once available. */
  proof?: RollupProof;
  /** Settlement transaction hash, once settled. */
  settlementTxHash?: string;
  /** Error message when the batch fails. */
  error?: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Last update timestamp (ms since epoch). */
  updatedAt: number;
}

/** A validity proof generated for a rollup batch. */
export interface RollupProof {
  /** Rollup protocol the proof was generated for. */
  protocol: RollupProtocol;
  /** Proof payload (hex/base64 encoded). */
  proof: string;
  /** Public inputs the proof commits to. */
  publicInputs: string[];
  /** Generation timestamp (ms since epoch). */
  generatedAt: number;
}

/** Result of optimizing a set of transactions into rollup batches. */
export interface RollupBatchOptimizationResult {
  /** Optimized batches ready for submission. */
  batches: RollupBatch[];
  /** Number of transactions that were batched. */
  batchedCount: number;
  /** Estimated cost savings versus submitting individually, as a decimal string. */
  estimatedSavings: string;
}

/** Monitoring snapshot for a rollup adapter. */
export interface RollupMonitoringSnapshot {
  /** Rollup protocol being monitored. */
  protocol: RollupProtocol;
  /** Number of batches currently tracked. */
  totalBatches: number;
  /** Number of batches that settled successfully. */
  settledCount: number;
  /** Number of batches that failed. */
  failedCount: number;
  /** Average settlement latency in milliseconds. */
  averageLatencyMs: number;
  /** Snapshot timestamp (ms since epoch). */
  updatedAt: number;
}

/** Rollup lifecycle events emitted to subscribers. */
export type RollupEvent =
  | { type: 'batch-created'; batch: RollupBatch }
  | { type: 'batch-submitted'; batch: RollupBatch }
  | { type: 'proof-generated'; batch: RollupBatch; proof: RollupProof }
  | { type: 'batch-settled'; batch: RollupBatch; settlementTxHash: string }
  | { type: 'batch-failed'; batch: RollupBatch; error: string }
  | { type: 'monitoring-updated'; snapshot: RollupMonitoringSnapshot };

/** Listener invoked for each emitted rollup event. */
export type RollupEventListener = (event: RollupEvent) => void;

/**
 * Rollup adapter for batching transactions and reducing settlement costs.
 *
 * Provides batch creation and optimization, proof generation, settlement,
 * and monitoring for optimistic and zk rollup protocols.
 */
export interface RollupAdapter {
  /** Create a rollup batch from the given transactions. */
  createBatch(params: RollupBatchParams): Promise<RollupBatch>;
  /** Optimize transactions into cost-efficient batches. */
  optimizeBatches(params: RollupBatchParams): Promise<RollupBatchOptimizationResult>;
  /** Generate a validity proof for a batch. */
  generateProof(batchId: string): Promise<RollupProof>;
  /** Settle a proven batch on the main chain. */
  settleBatch(batchId: string): Promise<RollupBatch>;
  /** Fetch the current state of a rollup batch by id. */
  getBatch(id: string): Promise<RollupBatch | undefined>;
  /** List all known rollup batches. */
  listBatches(): Promise<RollupBatch[]>;
  /** Fetch a monitoring snapshot for the rollup protocol. */
  getMonitoringSnapshot(protocol: RollupProtocol): Promise<RollupMonitoringSnapshot>;
  /** Subscribe to rollup lifecycle events; returns an unsubscribe function. */
  onEvent(listener: RollupEventListener): () => void;
}
