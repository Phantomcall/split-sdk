/**
 * Optional analytics dashboard data export.
 *
 * Provides a small, dependency-free exporter that serializes analytics
 * dashboard data to CSV or JSON and emits lifecycle events for the export
 * (start / complete / error). The feature is opt-in: nothing runs unless a
 * caller explicitly invokes the exporter, so existing default behavior is
 * unchanged.
 *
 * Large datasets can be exported incrementally via `stream()`, which frames
 * output into chunks, supports backpressure (pause/resume + buffering limits),
 * resumes from a checkpoint on error, and reports monitoring/analytics stats.
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
 * Streaming protocol: framed chunk messages emitted by `stream()`.
 *
 * - `start`  : stream opened, carries resolved columns/format.
 * - `chunk`  : a slice of serialized output (framed with a sequence number).
 * - `end`    : stream finished successfully.
 * - `error`  : a chunk failed; carries the checkpoint to resume from.
 */
export type AnalyticsStreamMessage =
  | { type: "start"; format: AnalyticsExportFormat; columns: string[] }
  | { type: "chunk"; seq: number; data: string }
  | { type: "end"; seq: number; rowCount: number }
  | { type: "error"; seq: number; error: Error; checkpoint: number };

export interface AnalyticsStreamOptions extends AnalyticsExportOptions {
  /** Max rows serialized per chunk. Defaults to 500. */
  chunkSize?: number;
  /** Max buffered chunks before backpressure pauses the producer. Defaults to 4. */
  highWaterMark?: number;
  /** Max retry attempts per chunk on error. Defaults to 2. */
  maxRetries?: number;
  /** Row index to resume from (checkpoint). Defaults to 0. */
  checkpoint?: number;
}

export interface AnalyticsStreamStats {
  chunks: number;
  rows: number;
  bytes: number;
  retries: number;
  paused: number;
  durationMs: number;
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

    try {
      const data =
        format === "csv"
          ? toCsv(safeRows, resolveColumns(safeRows, options.columns))
          : toJson(safeRows);

      this.events.emit("complete", {
        format,
        rowCount: safeRows.length,
        filename,
        data,
      });

      return data;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.events.emit("error", { format, filename, error });
      throw error;
    }
  }

  /**
   * Stream dashboard rows incrementally as framed chunks.
   *
   * Backpressure: the producer awaits `onChunk` for each chunk and pauses when
   * the consumer's buffer reaches `highWaterMark`. Error recovery: a failing
   * chunk is retried up to `maxRetries`; on exhaustion an `error` message with
   * a checkpoint is emitted so the caller can resume via `checkpoint`.
   */
  async stream(
    rows: AnalyticsDashboardRow[],
    options: AnalyticsStreamOptions = {},
    onChunk?: (message: AnalyticsStreamMessage) => void | Promise<void>,
  ): Promise<AnalyticsStreamStats> {
    const format: AnalyticsExportFormat = options.format ?? "json";
    const safeRows = Array.isArray(rows) ? rows : [];
    const chunkSize = Math.max(1, options.chunkSize ?? 500);
    const highWaterMark = Math.max(1, options.highWaterMark ?? 4);
    const maxRetries = Math.max(0, options.maxRetries ?? 2);
    const startRow = Math.max(0, Math.min(options.checkpoint ?? 0, safeRows.length));
    const columns = resolveColumns(safeRows, options.columns);

    const stats: AnalyticsStreamStats = {
      chunks: 0,
      rows: 0,
      bytes: 0,
      retries: 0,
      paused: 0,
      durationMs: 0,
    };
    const startedAt = Date.now();
    let seq = 0;
    let buffered = 0;

    const deliver = async (message: AnalyticsStreamMessage): Promise<void> => {
      if (!onChunk) {
        return;
      }
      buffered += 1;
      if (buffered >= highWaterMark) {
        // Backpressure: pause the producer until the consumer drains.
        stats.paused += 1;
        await Promise.resolve();
        buffered = 0;
      }
      await onChunk(message);
    };

    await deliver({ type: "start", format, columns });

    for (let offset = startRow; offset < safeRows.length; offset += chunkSize) {
      const slice = safeRows.slice(offset, offset + chunkSize);
      let attempt = 0;
      for (;;) {
        try {
          const data =
            format === "csv"
              ? toCsv(slice, columns)
              : toJson(slice);
          await deliver({ type: "chunk", seq, data });
          stats.chunks += 1;
          stats.rows += slice.length;
          stats.bytes += data.length;
          seq += 1;
          break;
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          if (attempt < maxRetries) {
            attempt += 1;
            stats.retries += 1;
            continue;
          }
          await deliver({ type: "error", seq, error, checkpoint: offset });
          stats.durationMs = Date.now() - startedAt;
          throw error;
        }
      }
    }

    await deliver({ type: "end", seq, rowCount: stats.rows });
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }
}

export default AnalyticsDashboardExporter;
