/**
 * Load generators for the load testing and benchmarking suite (#1190).
 *
 * Drives configurable concurrency/duration against representative SDK
 * scenarios and collects per-request latency samples so the reporting and
 * baseline layers can compute throughput, percentiles and error rates.
 */

export interface LoadScenario {
  /** Stable identifier used in reports and baselines. */
  name: string;
  /** Human readable description of what the scenario exercises. */
  description: string;
  /** A single unit of work executed by the generator. */
  run: () => Promise<unknown>;
}

export interface LoadGeneratorOptions {
  /** Number of concurrent workers. Defaults to 1. */
  concurrency?: number;
  /** Total wall-clock duration in milliseconds. Defaults to 1000. */
  durationMs?: number;
  /** Optional cap on total iterations across all workers. */
  maxIterations?: number;
  /** Optional delay between iterations per worker, in milliseconds. */
  thinkTimeMs?: number;
}

export interface LoadSample {
  /** Latency of the iteration in milliseconds. */
  latencyMs: number;
  /** Whether the iteration completed without throwing. */
  success: boolean;
  /** Error message when the iteration failed. */
  error?: string;
}

export interface LoadResult {
  scenario: string;
  concurrency: number;
  durationMs: number;
  /** Total iterations attempted (successful + failed). */
  iterations: number;
  /** Iterations that completed without throwing. */
  successes: number;
  /** Iterations that threw. */
  failures: number;
  /** Successful iterations per second over the measured window. */
  throughput: number;
  /** Fraction of failed iterations in [0, 1]. */
  errorRate: number;
  /** Latency percentiles in milliseconds (successful iterations only). */
  latency: {
    min: number;
    mean: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  };
  /** Raw samples for downstream trend analysis. */
  samples: LoadSample[];
}

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_DURATION_MS = 1000;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarizeLatency(samples: LoadSample[]): LoadResult['latency'] {
  const latencies = samples
    .filter((s) => s.success)
    .map((s) => s.latencyMs)
    .sort((a, b) => a - b);

  if (latencies.length === 0) {
    return { min: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }

  const sum = latencies.reduce((acc, v) => acc + v, 0);
  return {
    min: latencies[0],
    mean: sum / latencies.length,
    p50: percentile(latencies, 50),
    p90: percentile(latencies, 90),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1],
  };
}

/**
 * Run a scenario under a fixed concurrency for a bounded duration and
 * collect latency/error samples for reporting and baseline comparison.
 */
export async function runLoadGenerator(
  scenario: LoadScenario,
  options: LoadGeneratorOptions = {},
): Promise<LoadResult> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  const durationMs = Math.max(0, options.durationMs ?? DEFAULT_DURATION_MS);
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const thinkTimeMs = Math.max(0, options.thinkTimeMs ?? 0);

  const samples: LoadSample[] = [];
  const deadline = Date.now() + durationMs;
  let iterations = 0;

  const worker = async (): Promise<void> => {
    while (Date.now() < deadline && iterations < maxIterations) {
      iterations += 1;
      const startedAt = Date.now();
      try {
        await scenario.run();
        samples.push({ latencyMs: Date.now() - startedAt, success: true });
      } catch (error) {
        samples.push({
          latencyMs: Date.now() - startedAt,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (thinkTimeMs > 0) await sleep(thinkTimeMs);
    }
  };

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = Math.max(1, Date.now() - startedAt);

  const successes = samples.filter((s) => s.success).length;
  const failures = samples.length - successes;

  return {
    scenario: scenario.name,
    concurrency,
    durationMs: elapsedMs,
    iterations: samples.length,
    successes,
    failures,
    throughput: (successes / elapsedMs) * 1000,
    errorRate: samples.length === 0 ? 0 : failures / samples.length,
    latency: summarizeLatency(samples),
    samples,
  };
}

/**
 * Run multiple scenarios sequentially and return their results keyed by name.
 */
export async function runLoadSuite(
  scenarios: LoadScenario[],
  options: LoadGeneratorOptions = {},
): Promise<LoadResult[]> {
  const results: LoadResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runLoadGenerator(scenario, options));
  }
  return results;
}
