import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PriceOracle } from '../priceOracle';

/**
 * Property-based tests for the PriceOracle.
 *
 * fast-check provides generators (arbitraries) and integrated shrinking, so
 * failing cases are automatically minimized to the smallest counterexample.
 */

// --- Generators -------------------------------------------------------------

// A valid positive price (finite, > 0).
const priceArb = fc.double({ min: 0.000001, max: 1_000_000, noNaN: true, noDefaultInfinity: true });

// A non-negative weight used when combining sources.
const weightArb = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });

// A timestamp in a sane range (ms since epoch).
const timestampArb = fc.integer({ min: 0, max: 4_102_444_800_000 });

// A single price observation.
const observationArb = fc.record({
  price: priceArb,
  weight: weightArb,
  timestamp: timestampArb,
});

// A non-empty list of observations.
const observationsArb = fc.array(observationArb, { minLength: 1, maxLength: 20 });

// --- Properties -------------------------------------------------------------

describe('PriceOracle property-based tests', () => {
  it('weighted average always lies within the min/max of the inputs', () => {
    fc.assert(
      fc.property(observationsArb, (observations) => {
        const result = PriceOracle.weightedAverage(observations);
        const prices = observations.map((o) => o.price);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        expect(result).toBeGreaterThanOrEqual(min - 1e-9);
        expect(result).toBeLessThanOrEqual(max + 1e-9);
      }),
    );
  });

  it('weighted average is order-independent', () => {
    fc.assert(
      fc.property(observationsArb, (observations) => {
        const forward = PriceOracle.weightedAverage(observations);
        const reversed = PriceOracle.weightedAverage([...observations].reverse());
        expect(forward).toBeCloseTo(reversed, 9);
      }),
    );
  });

  it('a single observation yields its own price', () => {
    fc.assert(
      fc.property(observationArb, (observation) => {
        const result = PriceOracle.weightedAverage([observation]);
        expect(result).toBeCloseTo(observation.price, 9);
      }),
    );
  });

  it('scaling all prices by a positive factor scales the average', () => {
    fc.assert(
      fc.property(observationsArb, fc.double({ min: 0.01, max: 100, noNaN: true }), (observations, factor) => {
        const base = PriceOracle.weightedAverage(observations);
        const scaled = PriceOracle.weightedAverage(
          observations.map((o) => ({ ...o, price: o.price * factor })),
        );
        expect(scaled).toBeCloseTo(base * factor, 6);
      }),
    );
  });

  it('stale observations are excluded from the average', () => {
    fc.assert(
      fc.property(observationsArb, timestampArb, (observations, now) => {
        const maxAge = 60_000;
        const fresh = observations.filter((o) => now - o.timestamp <= maxAge);
        const result = PriceOracle.weightedAverage(observations, { now, maxAge });
        if (fresh.length === 0) {
          expect(result).toBeNaN();
        } else {
          const prices = fresh.map((o) => o.price);
          expect(result).toBeGreaterThanOrEqual(Math.min(...prices) - 1e-9);
          expect(result).toBeLessThanOrEqual(Math.max(...prices) + 1e-9);
        }
      }),
    );
  });
});
