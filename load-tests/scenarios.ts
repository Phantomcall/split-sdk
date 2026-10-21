/**
 * Load test scenarios for the SDK.
 *
 * Each scenario describes a representative SDK operation that can be driven
 * by the load generator (see ./generator.ts). Scenarios are intentionally
 * side-effect free: they only build the inputs and invoke the SDK surface so
 * the generator can measure throughput, latency and error rates.
 */

export interface LoadScenarioContext {
  /** Monotonic iteration index for the current worker. */
  iteration: number;
  /** Worker (virtual user) index. */
  worker: number;
  /** Deterministic pseudo-random source in [0, 1). */
  random: () => number;
}

export interface LoadScenario {
  /** Stable identifier used in reports and baselines. */
  name: string;
  /** Human readable description. */
  description: string;
  /** Relative weight when sampling scenarios in a mixed workload. */
  weight: number;
  /** Execute one iteration of the scenario. */
  run: (ctx: LoadScenarioContext) => Promise<unknown>;
}

/** Minimal shape of the SDK surface the scenarios depend on. */
export interface LoadTestSdk {
  splitInvoice?: (input: SplitInvoiceInput) => Promise<unknown>;
  batchPayments?: (input: BatchPaymentsInput) => Promise<unknown>;
  handleWebhook?: (input: WebhookInput) => Promise<unknown>;
}

export interface SplitInvoiceInput {
  invoiceId: string;
  total: string;
  recipients: Array<{ address: string; share: number }>;
}

export interface BatchPaymentsInput {
  payments: Array<{ to: string; amount: string; asset: string }>;
}

export interface WebhookInput {
  event: string;
  payload: Record<string, unknown>;
  signature: string;
}

const ASSETS = ["XLM", "USDC", "AQUA"];

function pick<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length) % items.length];
}

function pseudoAddress(random: () => number): string {
  let out = "G";
  for (let i = 0; i < 55; i += 1) {
    out += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(random() * 32) % 32];
  }
  return out;
}

/**
 * Build the default scenario set against a concrete SDK instance.
 * Scenarios whose SDK method is unavailable are skipped so the suite can run
 * against partial builds without failing.
 */
export function createScenarios(sdk: LoadTestSdk): LoadScenario[] {
  const scenarios: LoadScenario[] = [];

  if (typeof sdk.splitInvoice === "function") {
    scenarios.push({
      name: "invoice-split",
      description: "Split an invoice across a small set of recipients",
      weight: 3,
      run: async ({ random, iteration }) => {
        const recipientCount = 2 + Math.floor(random() * 3);
        const recipients = Array.from({ length: recipientCount }, () => ({
          address: pseudoAddress(random),
          share: 1 / recipientCount,
        }));
        return sdk.splitInvoice!({ invoiceId: `inv-${iteration}`, total: "100.0000000", recipients });
      },
    });
  }

  if (typeof sdk.batchPayments === "function") {
    scenarios.push({
      name: "batch-payments",
      description: "Submit a batch of payments in a single call",
      weight: 2,
      run: async ({ random }) => {
        const size = 1 + Math.floor(random() * 10);
        const payments = Array.from({ length: size }, () => ({
          to: pseudoAddress(random),
          amount: (random() * 100).toFixed(7),
          asset: pick(ASSETS, random),
        }));
        return sdk.batchPayments!({ payments });
      },
    });
  }

  if (typeof sdk.handleWebhook === "function") {
    scenarios.push({
      name: "webhook-handling",
      description: "Process an incoming webhook event",
      weight: 1,
      run: async ({ random, iteration }) => {
        return sdk.handleWebhook!({
          event: "payment.completed",
          payload: { id: `evt-${iteration}`, amount: (random() * 100).toFixed(7) },
          signature: "test-signature",
        });
      },
    });
  }

  return scenarios;
}

/**
 * Sample a scenario from a weighted set using the provided random source.
 */
export function sampleScenario(scenarios: LoadScenario[], random: () => number): LoadScenario {
  const total = scenarios.reduce((sum, s) => sum + s.weight, 0);
  let threshold = random() * total;
  for (const scenario of scenarios) {
    threshold -= scenario.weight;
    if (threshold <= 0) return scenario;
  }
  return scenarios[scenarios.length - 1];
}
