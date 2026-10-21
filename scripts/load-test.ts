#!/usr/bin/env ts-node
/**
 * Load testing and benchmarking suite.
 *
 * Drives configurable concurrency/duration against representative SDK
 * operations, reports throughput/latency percentiles/error rates, persists
 * performance baselines, and detects regressions against prior baselines.
 *
 * Usage:
 *   ts-node scripts/load-test.ts --scenario invoice-split --concurrency 10 --duration 5000
 *   ts-node scripts/load-test.ts --all --update-baseline
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoadTestScenario {
  name: string;
  description: string;
  /** Single unit of work executed by a virtual user. */
  run: () => Promise<void>;
}

export interface LoadTestOptions {
  concurrency: number;
  durationMs: number;
}

export interface ScenarioResult {
  scenario: string;
  concurrency: number;
  durationMs: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorRate: number;
  throughputPerSec: number;
  latencyMs: {
    min: number;
    mean: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  };
  errors: Record<string, number>;
}

export interface Baseline {
  generatedAt: string;
  results: Record<string, ScenarioResult>;
}

export interface RegressionFinding {
  scenario: string;
  metric: string;
  baseline: number;
  current: number;
  changePct: number;
  regressed: boolean;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Representative SDK operations. These are lightweight simulations so the
 * suite can run without network access; swap the bodies for real SDK calls
 * when running against a live environment.
 */
export const scenarios: LoadTestScenario[] = [
  {
    name: 'invoice-split',
    description: 'Split an invoice into line items and compute totals',
    run: async () => {
      const items = Array.from({ length: 5 }, (_, i) => ({ amount: (i + 1) * 100 }));
      const total = items.reduce((sum, it) => sum + it.amount, 0);
      if (total <= 0) throw new Error('invalid total');
      await sleep(1);
    },
  },
  {
    name: 'batch-payments',
    description: 'Submit a batch of payments',
    run: async () => {
      const batch = Array.from({ length: 10 }, (_, i) => ({ id: i, amount: 50 }));
      if (batch.length === 0) throw new Error('empty batch');
      await sleep(2);
    },
  },
  {
    name: 'webhook-handling',
    description: 'Parse and dispatch a webhook payload',
    run: async () => {
      const payload = { type: 'payment.succeeded', data: { id: 'abc' } };
      if (!payload.type) throw new Error('missing type');
      await sleep(1);
    },
  },
];

// ---------------------------------------------------------------------------
// Load generator
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export async function runScenario(
  scenario: LoadTestScenario,
  options: LoadTestOptions
): Promise<ScenarioResult> {
  const latencies: number[] = [];
  const errors: Record<string, number> = {};
  let success = 0;
  let failed = 0;
  const deadline = Date.now() + options.durationMs;

  const worker = async () => {
    while (Date.now() < deadline) {
      const start = Date.now();
      try {
        await scenario.run();
        success++;
      } catch (err) {
        failed++;
        const key = err instanceof Error ? err.message : String(err);
        errors[key] = (errors[key] || 0) + 1;
      } finally {
        latencies.push(Date.now() - start);
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));

  latencies.sort((a, b) => a - b);
  const total = success + failed;
  const sum = latencies.reduce((a, b) => a + b, 0);

  return {
    scenario: scenario.name,
    concurrency: options.concurrency,
    durationMs: options.durationMs,
    totalRequests: total,
    successfulRequests: success,
    failedRequests: failed,
    errorRate: total === 0 ? 0 : failed / total,
    throughputPerSec: options.durationMs === 0 ? 0 : (total / options.durationMs) * 1000,
    latencyMs: {
      min: latencies[0] || 0,
      mean: total === 0 ? 0 : sum / total,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] || 0,
    },
    errors,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatReport(results: ScenarioResult[]): string {
  const lines: string[] = [];
  lines.push('Load Test Report');
  lines.push('================');
  for (const r of results) {
    lines.push('');
    lines.push(`Scenario: ${r.scenario} (concurrency=${r.concurrency}, duration=${r.durationMs}ms)`);
    lines.push(`  Requests:   ${r.totalRequests} (ok=${r.successfulRequests}, failed=${r.failedRequests})`);
    lines.push(`  Throughput: ${r.throughputPerSec.toFixed(2)} req/s`);
    lines.push(`  Error rate: ${(r.errorRate * 100).toFixed(2)}%`);
    lines.push(
      `  Latency:    min=${r.latencyMs.min}ms mean=${r.latencyMs.mean.toFixed(2)}ms ` +
        `p50=${r.latencyMs.p50}ms p90=${r.latencyMs.p90}ms p95=${r.latencyMs.p95}ms ` +
        `p99=${r.latencyMs.p99}ms max=${r.latencyMs.max}ms`
    );
    const errKeys = Object.keys(r.errors);
    if (errKeys.length > 0) {
      lines.push('  Errors:');
      for (const k of errKeys) lines.push(`    - ${k}: ${r.errors[k]}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Baselines & regression detection
// ---------------------------------------------------------------------------

const BASELINE_PATH = path.join(__dirname, 'load-test-baseline.json');

/** Regression thresholds: throughput drop or latency increase beyond these. */
export const REGRESSION_THRESHOLDS = {
  throughputDropPct: 10,
  latencyIncreasePct: 15,
  errorRateIncreaseAbs: 0.02,
};

export function loadBaseline(file = BASELINE_PATH): Baseline | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
  } catch {
    return null;
  }
}

export function saveBaseline(results: ScenarioResult[], file = BASELINE_PATH): void {
  const baseline: Baseline = {
    generatedAt: new Date().toISOString(),
    results: Object.fromEntries(results.map((r) => [r.scenario, r])),
  };
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2));
}

function pctChange(baseline: number, current: number): number {
  if (baseline === 0) return current === 0 ? 0 : 100;
  return ((current - baseline) / baseline) * 100;
}

export function detectRegressions(
  baseline: Baseline,
  results: ScenarioResult[]
): RegressionFinding[] {
  const findings: RegressionFinding[] = [];
  for (const r of results) {
    const base = baseline.results[r.scenario];
    if (!base) continue;

    const tpChange = pctChange(base.throughputPerSec, r.throughputPerSec);
    findings.push({
      scenario: r.scenario,
      metric: 'throughputPerSec',
      baseline: base.throughputPerSec,
      current: r.throughputPerSec,
      changePct: tpChange,
      regressed: tpChange < -REGRESSION_THRESHOLDS.throughputDropPct,
    });

    const p95Change = pctChange(base.latencyMs.p95, r.latencyMs.p95);
    findings.push({
      scenario: r.scenario,
      metric: 'latencyMs.p95',
      baseline: base.latencyMs.p95,
      current: r.latencyMs.p95,
      changePct: p95Change,
      regressed: p95Change > REGRESSION_THRESHOLDS.latencyIncreasePct,
    });

    const errDelta = r.errorRate - base.errorRate;
    findings.push({
      scenario: r.scenario,
      metric: 'errorRate',
      baseline: base.errorRate,
      current: r.errorRate,
      changePct: pctChange(base.errorRate, r.errorRate),
      regressed: errDelta > REGRESSION_THRESHOLDS.errorRateIncreaseAbs,
    });
  }
  return findings;
}

export function formatTrends(findings: RegressionFinding[]): string {
  if (findings.length === 0) return 'No baseline available for trend analysis.';
  const lines = ['Trend Analysis vs Baseline', '=========================='];
  for (const f of findings) {
    const arrow = f.changePct > 0 ? '\u2191' : f.changePct < 0 ? '\u2193' : '=';
    const flag = f.regressed ? ' [REGRESSION]' : '';
    lines.push(
      `  ${f.scenario} ${f.metric}: ${f.baseline.toFixed(2)} -> ${f.current.toFixed(2)} ` +
        `(${arrow}${Math.abs(f.changePct).toFixed(1)}%)${flag}`
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const concurrency = Number(args.concurrency ?? 10);
  const durationMs = Number(args.duration ?? 5000);

  const selected = args.all
    ? scenarios
    : scenarios.filter((s) => s.name === args.scenario);

  if (selected.length === 0) {
    console.error(`Unknown scenario. Available: ${scenarios.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    results.push(await runScenario(scenario, { concurrency, durationMs }));
  }

  console.log(formatReport(results));

  const baseline = loadBaseline();
  if (baseline) {
    const findings = detectRegressions(baseline, results);
    console.log('\n' + formatTrends(findings));
    if (args['update-baseline']) saveBaseline(results);
    if (findings.some((f) => f.regressed)) {
      console.error('\nRegression detected against baseline.');
      process.exit(1);
    }
  } else {
    console.log('\nNo baseline found; writing initial baseline.');
    saveBaseline(results);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
