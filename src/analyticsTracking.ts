/**
 * Optional analytics tracking for SDK usage metrics with privacy controls and reporting.
 *
 * Designed to provide privacy-preserving usage metrics for SDK consumers.
 * Strictly opt-in (enabled: false by default).
 */

import { createHash, randomBytes } from "crypto";

export type PrivacyLevel = "strict" | "anonymized" | "standard";

export interface AnalyticsPrivacyConfig {
  /**
   * Overall privacy level:
   * - "strict": completely drops all addresses, metadata, and custom properties.
   * - "anonymized": hashes/masks Stellar public keys and scrubs sensitive data (default).
   * - "standard": allows public keys but scrubs secret keys and credentials.
   */
  level?: PrivacyLevel;
  /** Whether to anonymize Stellar public keys (G...). Default: true. */
  anonymizeAddresses?: boolean;
  /** Whether to strip secret keys (S...) and credentials. Default: true. */
  stripSecrets?: boolean;
  /** Whether to strip PII (email, IP, names). Default: true. */
  allowPII?: boolean;
  /** Respect browser / environment Do Not Track headers or flags. Default: true. */
  respectDoNotTrack?: boolean;
}

export interface AnalyticsEventInput {
  name: string;
  category?: string;
  properties?: Record<string, unknown>;
  timestamp?: number;
}

export interface AnalyticsEvent {
  name: string;
  category: string;
  properties: Record<string, unknown>;
  timestamp: number;
}

export interface MethodMetric {
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
}

export interface AnalyticsReport {
  generatedAt: number;
  periodMs: number;
  privacyLevel: PrivacyLevel;
  totalEvents: number;
  totalMethodCalls: number;
  totalErrors: number;
  overallErrorRate: number;
  methods: Record<string, MethodMetric>;
  eventsByCategory: Record<string, number>;
  metrics: Record<string, number>;
  events: AnalyticsEvent[];
}

export interface AnalyticsTrackerOptions {
  /** Strictly opt-in: defaults to false. */
  enabled?: boolean;
  /** Privacy controls configuration. */
  privacy?: AnalyticsPrivacyConfig;
  /** Remote reporting endpoint URL for flush(). */
  endpoint?: string;
  /** Auto-flush interval in milliseconds (0 or undefined to disable auto-flush). */
  flushIntervalMs?: number;
  /** Maximum number of raw events retained in the collector buffer. Default: 1000. */
  maxQueueSize?: number;
  /** Custom reporter callback invoked on flush or report generation. */
  onReport?: (report: AnalyticsReport) => void;
  /** Optional custom fetch implementation for network reporting. */
  fetchFn?: typeof fetch;
  /** Distributed tracing configuration. */
  tracing?: TracingConfig;
}

// ---------------------------------------------------------------------------
// Distributed Tracing
// ---------------------------------------------------------------------------

/**
 * W3C Trace Context compatible identifiers. A trace is a tree of spans sharing
 * the same traceId; each span has its own spanId and an optional parentSpanId.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attributes: Record<string, unknown>;
  status: "ok" | "error";
  error?: string;
}

export interface TracingConfig {
  /** Enable tracing. Default: false (opt-in, consistent with analytics). */
  enabled?: boolean;
  /** Sampling ratio in [0, 1]. Default: 1 (sample everything). */
  sampleRate?: number;
  /** Service name attached to exported spans. */
  serviceName?: string;
  /** Maximum number of finished spans retained before export. Default: 1000. */
  maxSpans?: number;
  /** Custom span exporter invoked on flush. */
  exporter?: (spans: Span[]) => void;
}

const TRACEPARENT_PATTERN = /^([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Lightweight W3C Trace Context implementation: sampling, span creation,
 * propagation via the `traceparent` header, and buffered export.
 */
export class Tracer {
  private readonly enabled: boolean;
  private readonly sampleRate: number;
  private readonly serviceName: string;
  private readonly maxSpans: number;
  private readonly exporter?: (spans: Span[]) => void;
  private readonly spans: Span[] = [];

  constructor(config?: TracingConfig) {
    this.enabled = config?.enabled ?? false;
    this.sampleRate = Math.min(1, Math.max(0, config?.sampleRate ?? 1));
    this.serviceName = config?.serviceName ?? "stellar-sdk";
    this.maxSpans = config?.maxSpans ?? 1000;
    this.exporter = config?.exporter;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Decide whether a new trace should be sampled. */
  shouldSample(): boolean {
    if (!this.enabled) return false;
    if (this.sampleRate >= 1) return true;
    if (this.sampleRate <= 0) return false;
    return Math.random() < this.sampleRate;
  }

  /** Start a new root trace context. */
  startTrace(): TraceContext {
    return {
      traceId: randomHex(16),
      spanId: randomHex(8),
      sampled: this.shouldSample(),
    };
  }

  /** Parse an incoming `traceparent` header into a TraceContext. */
  extractTraceContext(headers: Record<string, string | undefined>): TraceContext | undefined {
    const raw = headers["traceparent"] ?? headers["Traceparent"];
    if (!raw) return undefined;
    const match = TRACEPARENT_PATTERN.exec(raw.trim().toLowerCase());
    if (!match) return undefined;
    const [, traceId, parentSpanId, , flags] = match;
    if (traceId === "0".repeat(32) || parentSpanId === "0".repeat(16)) return undefined;
    return {
      traceId,
      spanId: randomHex(8),
      parentSpanId,
      sampled: (parseInt(flags, 16) & 0x01) === 0x01,
    };
  }

  /** Serialize a TraceContext into a `traceparent` header value. */
  injectTraceContext(context: TraceContext): Record<string, string> {
    const flags = context.sampled ? "01" : "00";
    return {
      traceparent: `${context.traceId}-${context.spanId}-${flags}`,
    };
  }

  /** Create a child span context from a parent context. */
  childContext(parent: TraceContext): TraceContext {
    return {
      traceId: parent.traceId,
      spanId: randomHex(8),
      parentSpanId: parent.spanId,
      sampled: parent.sampled,
    };
  }

  /** Begin a span for a tracked operation. */
  startSpan(name: string, context?: TraceContext, attributes?: Record<string, unknown>): Span {
    const ctx = context ?? this.startTrace();
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: ctx.parentSpanId,
      name,
      startTime: Date.now(),
      attributes: { "service.name": this.serviceName, ...(attributes ?? {}) },
      status: "ok",
    };
  }

  /** Finish a span, recording duration/status and buffering it for export. */
  endSpan(span: Span, error?: unknown): Span {
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    if (error !== undefined) {
      span.status = "error";
      span.error = error instanceof Error ? error.message : String(error);
    }
    if (span.traceId && this.enabled) {
      if (this.spans.length >= this.maxSpans) {
        this.spans.shift();
      }
      this.spans.push(span);
    }
    return span;
  }

  /** Convenience wrapper: run fn inside a span, ending it on completion. */
  async withSpan<T>(
    name: string,
    fn: (context: TraceContext) => Promise<T> | T,
    context?: TraceContext,
    attributes?: Record<string, unknown>,
  ): Promise<T> {
    const ctx = context ?? this.startTrace();
    const span = this.startSpan(name, ctx, attributes);
    try {
      const result = await fn(ctx);
      this.endSpan(span);
      return result;
    } catch (err) {
      this.endSpan(span, err);
      throw err;
    }
  }

  /** Export buffered spans via the configured exporter and clear the buffer. */
  flush(): Span[] {
    const batch = this.spans.splice(0, this.spans.length);
    if (batch.length > 0 && this.exporter) {
      this.exporter(batch);
    }
    return batch;
  }

  /** Return a copy of currently buffered spans (for visualization). */
  getSpans(): Span[] {
    return [...this.spans];
  }
}

// ---------------------------------------------------------------------------
// Privacy Controller
// ---------------------------------------------------------------------------

const STELLAR_SECRET_PATTERN = /\bS[A-Z0-9]{55}\b/g;
const STELLAR_PUBLIC_PATTERN = /\bG[A-Z0-9]{55}\b/g;
const PII_KEYS = new Set([
  "ip",
  "ipaddress",
  "ip_address",
  "email",
  "emailaddress",
  "email_address",
  "phone",
  "phonenumber",
  "ssn",
  "password",
  "secret",
  "privatekey",
  "private_key",
  "authorization",
  "token",
]);

export class PrivacyController {
  private readonly config: Required<AnalyticsPrivacyConfig>;

  constructor(config?: AnalyticsPrivacyConfig) {
    this.config = {
      level: config?.level ?? "anonymized",
      anonymizeAddresses: config?.anonymizeAddresses ?? true,
      stripSecrets: config?.stripSecrets ?? true,
      allowPII: config?.allowPII ?? false,
      respectDoNotTrack: config?.respectDoNotTrack ?? true,
    };
  }

  get level(): PrivacyLevel {
    return this.config.level;
  }

  isDoNotTrackEnabled(): boolean {
    if (!this.config.respectDoNotTrack) return false;
    if (typeof navigator !== "undefined" && "doNotTrack" in navigator) {
      return (navigator as { doNotTrack?: string }).doNotTrack === "1";
    }
    if (typeof process !== "undefined" && process.env?.DO_NOT_TRACK === "1") {
      return true;
    }
    return false;
  }

  anonymizeAddress(address: string): string {
    if (this.config.level === "strict") {
      return "[REDACTED_ADDRESS]";
    }
    if (!this.config.anonymizeAddresses && this.config.level === "standard") {
      return address;
    }
    // Deterministic pseudonym: first 4, last 4 chars + 8-char sha256 hash
    const hash = createHash("sha256").update(address).digest("hex").slice(0, 8);
    return `${address.slice(0, 4)}...${hash}...${address.slice(-4)}`;
  }

  sanitizeString(val: string): string {
    let out = val;
    if (this.config.stripSecrets) {
      out = out.replace(STELLAR_SECRET_PATTERN, "[REDACTED_SECRET]");
    }
    if (this.config.anonymizeAddresses || this.config.level !== "standard") {
      out = out.replace(STELLAR_PUBLIC_PATTERN, (match) => this.anonymizeAddress(match));
    }
    return out;
  }

  sanitizeValue(key: string, value: unknown): unknown {
    if (value === null || value === undefined) return value;

    const lowerKey = key.toLowerCase();
    if (!this.config.allowPII && PII_KEYS.has(lowerKey)) {
      return "[REDACTED_PII]";
    }

    if (typeof value === "string") {
      return this.sanitizeString(value);
    }

    if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value)) {
      if (this.config.level === "strict") return [];
      return value.map((item, idx) => this.sanitizeValue(`${key}_${idx}`, item));
    }

    if (typeof value === "object") {
      if (this.config.level === "strict") return {};
      return this.sanitizeProperties(value as Record<string, unknown>);
    }

    return String(value);
  }

  sanitizeProperties(properties?: Record<string, unknown>): Record<string, unknown> {
    if (!properties) return {};
    if (this.config.level === "strict") return {};

    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(properties)) {
      sanitized[key] = this.sanitizeValue(key, val);
    }
    return sanitized;
  }
}

// ---------------------------------------------------------------------------
// Analytics Collector
// ---------------------------------------------------------------------------

interface MethodRecord {
  count: number;
  errors: number;
  durations: number[];
}

export class AnalyticsCollector {
  private readonly maxQueueSize: number;
  private readonly events: AnalyticsEvent[] = [];
  private readonly methods = new Map<string, MethodRecord>();
  private readonly metrics = new Map<string, number>();
  private readonly categoryCounts = new Map<string, number>();
  private startTime: number = Date.now();

  constructor(maxQueueSize = 1000) {
    this.maxQueueSize = maxQueueSize;
  }

  recordEvent(event: AnalyticsEvent): void {
    if (this.events.length >= this.maxQueueSize) {
      this.events.shift(); // Evict oldest event when queue is full
    }
    this.events.push(event);

    const cat = event.category || "general";
    this.categoryCounts.set(cat, (this.categoryCounts.get(cat) ?? 0) + 1);
  }

  recordMethod(method: string, durationMs: number, success: boolean): void {
    let rec = this.methods.get(method);
    if (!rec) {
      rec = { count: 0, errors: 0, durations: [] };
      this.methods.set(method, rec);
    }
    rec.count += 1;
    if (!success) {
      rec.errors += 1;
    }
    rec.durations.push(durationMs);
    // Keep max 500 duration samples per method to avoid unbounded memory
    if (rec.durations.length > 500) {
      rec.durations.shift();
    }
  }

  recordMetric(name: string, value: number): void {
    this.metrics.set(name, (this.metrics.get(name) ?? 0) + value);
  }

  getEvents(): AnalyticsEvent[] {
    return [...this.events];
  }

  getMetrics(): Record<string, number> {
    return Object.fromEntries(this.metrics.entries());
  }

  private calculatePercentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  generateReport(privacy: PrivacyController): AnalyticsReport {
    const now = Date.now();
    const methods: Record<string, MethodMetric> = {};
    let totalMethodCalls = 0;
    let totalErrors = 0;

    for (const [name, rec] of this.methods.entries()) {
      const sorted = [...rec.durations].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, d) => acc + d, 0);
      methods[name] = {
        calls: rec.count,
        errors: rec.errors,
        errorRate: rec.count > 0 ? rec.errors / rec.count : 0,
        avgDurationMs: sorted.length > 0 ? sum / sorted.length : 0,
        minDurationMs: sorted.length > 0 ? sorted[0] : 0,
        maxDurationMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
        p50DurationMs: this.calculatePercentile(sorted, 50),
        p95DurationMs: this.calculatePercentile(sorted, 95),
        p99DurationMs: this.calculatePercentile(sorted, 99),
      };
      totalMethodCalls += rec.count;
      totalErrors += rec.errors;
    }

    return {
      generatedAt: now,
      periodMs: now - this.startTime,
      privacyLevel: privacy.level,
      totalEvents: this.events.length,
      totalMethodCalls,
      totalErrors,
      overallErrorRate: totalMethodCalls > 0 ? totalErrors / totalMethodCalls : 0,
      methods,
      eventsByCategory: Object.fromEntries(this.categoryCounts.entries()),
      metrics: this.getMetrics(),
      events: this.events.map((e) => ({
        ...e,
        properties: privacy.sanitizeProperties(e.properties),
      })),
    };
  }
}
