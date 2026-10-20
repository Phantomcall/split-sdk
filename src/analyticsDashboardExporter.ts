/**
 * Optional analytics dashboard data export.
 *
 * Provides a small, dependency-free exporter that serializes analytics
 * dashboard data to CSV or JSON and emits lifecycle events for the export
 * (start / complete / error). The feature is opt-in: nothing runs unless a
 * caller explicitly invokes the exporter, so existing default behavior is
 * unchanged.
 *
 * It also exposes lightweight performance metrics (counters, gauges and
 * histograms) so callers can monitor RPC latency, cache hit/miss rates and
 * batch operation performance, and export them in a standard format.
 */

export type AnalyticsExportFormat = "csv" | "json";

export interface AnalyticsDashboardRow {
  [key: string]: string | number | boolean | null | undefined;
}

export interface AnalyticsExportOptions {
  /** Output format. Defaults to "json". */
  format?: AnalyticsExportFormat;
  /** Optional explicit column ordering for CSV output. */
  columns?: string[];
  /** Optional filename hint included in the completion event. */
  filename?: string;
}

export interface AnalyticsExportStartEvent {
  format: AnalyticsExportFormat;
  rowCount: number;
  filename?: string;
}

export interface AnalyticsExportCompleteEvent {
  format: AnalyticsExportFormat;
  rowCount: number;
  filename?: string;
  data: string;
}

export interface AnalyticsExportErrorEvent {
  format: AnalyticsExportFormat;
  filename?: string;
  error: Error;
}

export interface AnalyticsExportEventMap {
  start: AnalyticsExportStartEvent;
  complete: AnalyticsExportCompleteEvent;
  error: AnalyticsExportErrorEvent;
}

export type AnalyticsExportEventName = keyof AnalyticsExportEventMap;

export type AnalyticsExportListener<K extends AnalyticsExportEventName> = (
  event: AnalyticsExportEventMap[K],
) => void;

/**
 * Minimal typed event emitter used to report export lifecycle events.
 */
export class AnalyticsExportEventEmitter {
  private readonly listeners: {
    [K in AnalyticsExportEventName]: Set<AnalyticsExportListener<K>>;
  } = {
    start: new Set(),
    complete: new Set(),
    error: new Set(),
  };

  on<K extends AnalyticsExportEventName>(
    event: K,
    listener: AnalyticsExportListener<K>,
  ): () => void {
    this.listeners[event].add(listener);
    return () => this.off(event, listener);
  }

  off<K extends AnalyticsExportEventName>(
    event: K,
    listener: AnalyticsExportListener<K>,
  ): void {
    this.listeners[event].delete(listener);
  }

  emit<K extends AnalyticsExportEventName>(
    event: K,
    payload: AnalyticsExportEventMap[K],
  ): void {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }
}

/**
 * Aggregated histogram snapshot for a single metric key.
 */
export interface MetricsHistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
}

/**
 * Standard-format metrics export payload (Prometheus-style naming).
 */
export interface MetricsExport {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, MetricsHistogramSnapshot>;
  /** Cache hit rate in [0, 1], or null when no lookups were recorded. */
  cacheHitRate: number | null;
}

/**
 * Lightweight, dependency-free metrics collector.
 *
 * Designed for minimal overhead: counters/gauges are plain map updates and
 * histograms keep running aggregates (no unbounded sample storage).
 */
export class MetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, MetricsHistogramSnapshot>();
  private cacheHits = 0;
  private cacheMisses = 0;

  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, value: number): void {
    const current = this.histograms.get(name);
    if (!current) {
      this.histograms.set(name, {
        count: 1,
        sum: value,
        min: value,
        max: value,
        avg: value,
      });
      return;
    }
    const count = current.count + 1;
    const sum = current.sum + value;
    this.histograms.set(name, {
      count,
      sum,
      min: Math.min(current.min, value),
      max: Math.max(current.max, value),
      avg: sum / count,
    });
  }

  /** Time an RPC request by method name, recording latency in ms. */
  async timeRpc<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.increment(`rpc.${method}.success`);
      return result;
    } catch (error) {
      this.increment(`rpc.${method}.error`);
      throw error;
    } finally {
      this.observe(`rpc.${method}.latency_ms`, Date.now() - start);
    }
  }

  /** Record a cache lookup outcome. */
  recordCache(hit: boolean): void {
    if (hit) {
      this.cacheHits += 1;
      this.increment("cache.hits");
    } else {
      this.cacheMisses += 1;
      this.increment("cache.misses");
    }
  }

  /** Record a batch operation's duration and size. */
  recordBatch(size: number, durationMs: number, success: boolean): void {
    this.increment(success ? "batch.success" : "batch.failure");
    this.observe("batch.size", size);
    this.observe("batch.duration_ms", durationMs);
  }

  /** Export all metrics in a standard, serializable format. */
  export(): MetricsExport {
    const total = this.cacheHits + this.cacheMisses;
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(this.histograms),
      cacheHitRate: total === 0 ? null : this.cacheHits / total,
    };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
}

function resolveColumns(
  rows: AnalyticsDashboardRow[],
  columns?: string[],
): string[] {
  if (columns && columns.length > 0) {
    return columns;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      seen.add(key);
    }
  }
  return Array.from(seen);
}

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows: AnalyticsDashboardRow[], columns: string[]): string {
  const header = columns.map(escapeCsvValue).join(",");
  const body = rows.map((row) =>
    columns.map((column) => escapeCsvValue(row[column])).join(","),
  );
  return [header, ...body].join("\n");
}

function toJson(rows: AnalyticsDashboardRow[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * Optional analytics dashboard exporter.
 *
 * Usage:
 * ```ts
 * const exporter = new AnalyticsDashboardExporter();
 * exporter.on("complete", (e) => console.log(e.data));
 * const csv = exporter.export(rows, { format: "csv" });
 * ```
 */
export class AnalyticsDashboardExporter {
  readonly events = new AnalyticsExportEventEmitter();
  readonly metrics = new MetricsCollector();

  on<K extends AnalyticsExportEventName>(
    event: K,
    listener: AnalyticsExportListener<K>,
  ): () => void {
    return this.events.on(event, listener);
  }

  off<K extends AnalyticsExportEventName>(
    event: K,
    listener: AnalyticsExportListener<K>,
  ): void {
    this.events.off(event, listener);
  }

  /**
   * Serialize dashboard rows into the requested format.
   * Emits `start`, then `complete` on success or `error` on failure.
   */
  export(
    rows: AnalyticsDashboardRow[],
    options: AnalyticsExportOptions = {},
  ): string {
    const format: AnalyticsExportFormat = options.format ?? "json";
    const filename = options.filename;
    const safeRows = Array.isArray(rows) ? rows : [];

    this.events.emit("start", {
      format,
      rowCount: safeRows.length,
      filename,
    });

    const start = Date.now();
    try {
      const data =
        format === "csv"
          ? toCsv(safeRows, resolveColumns(safeRows, options.columns))
          : toJson(safeRows);

      this.metrics.increment("export.success");
      this.metrics.observe("export.duration_ms", Date.now() - start);

      this.events.emit("complete", {
        format,
        rowCount: safeRows.length,
        filename,
        data,
      });

      return data;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.metrics.increment("export.error");
      this.metrics.observe("export.duration_ms", Date.now() - start);
      this.events.emit("error", { format, filename, error });
      throw error;
    }
  }
}

export default AnalyticsDashboardExporter;
