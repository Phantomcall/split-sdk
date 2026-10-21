import { describe, it, expect, beforeEach } from 'vitest';
import {
  Logger,
  LogLevel,
  LogAggregator,
  createLogger,
  type LogEntry,
} from '../logging';

describe('logging system', () => {
  let aggregator: LogAggregator;

  beforeEach(() => {
    aggregator = new LogAggregator();
  });

  it('creates structured log entries with timestamp, level, message and context', () => {
    const logger = createLogger({ aggregator, level: LogLevel.Debug });
    logger.info('hello', { userId: 'u1' });

    const entries = aggregator.getEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0] as LogEntry;
    expect(entry.level).toBe(LogLevel.Info);
    expect(entry.message).toBe('hello');
    expect(entry.context).toEqual({ userId: 'u1' });
    expect(typeof entry.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
  });

  it('enforces log levels by dropping entries below the threshold', () => {
    const logger = createLogger({ aggregator, level: LogLevel.Warn });
    logger.debug('dropped');
    logger.info('dropped');
    logger.warn('kept');
    logger.error('kept');

    const messages = aggregator.getEntries().map((e) => e.message);
    expect(messages).toEqual(['kept', 'kept']);
  });

  it('captures bound context merged into every entry', () => {
    const logger = createLogger({ aggregator, level: LogLevel.Debug }).withContext({
      requestId: 'req-1',
    });
    logger.info('first', { step: 1 });
    logger.info('second');

    const entries = aggregator.getEntries();
    expect(entries[0].context).toEqual({ requestId: 'req-1', step: 1 });
    expect(entries[1].context).toEqual({ requestId: 'req-1' });
  });

  it('aggregates entries and supports filtering', () => {
    const logger = createLogger({ aggregator, level: LogLevel.Debug });
    logger.debug('a');
    logger.info('b');
    logger.error('c');

    expect(aggregator.getEntries()).toHaveLength(3);
    expect(aggregator.filter({ level: LogLevel.Error })).toHaveLength(1);
    expect(aggregator.filter({ message: 'b' })).toHaveLength(1);
    expect(aggregator.filter({ level: LogLevel.Debug, message: 'a' })).toHaveLength(1);
  });

  it('provides analytics over aggregated entries', () => {
    const logger = createLogger({ aggregator, level: LogLevel.Debug });
    logger.debug('a');
    logger.info('b');
    logger.info('c');
    logger.error('d');

    const analytics = aggregator.analytics();
    expect(analytics.total).toBe(4);
    expect(analytics.byLevel[LogLevel.Debug]).toBe(1);
    expect(analytics.byLevel[LogLevel.Info]).toBe(2);
    expect(analytics.byLevel[LogLevel.Error]).toBe(1);
  });

  it('clears aggregated entries', () => {
    const logger = createLogger({ aggregator, level: LogLevel.Debug });
    logger.info('a');
    aggregator.clear();
    expect(aggregator.getEntries()).toHaveLength(0);
  });

  it('exposes a Logger class with level helpers', () => {
    const logger = new Logger({ aggregator, level: LogLevel.Debug });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(aggregator.getEntries().map((e) => e.level)).toEqual([
      LogLevel.Debug,
      LogLevel.Info,
      LogLevel.Warn,
      LogLevel.Error,
    ]);
  });
});
