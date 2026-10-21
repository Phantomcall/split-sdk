import {
  PriceOracle,
  parseOraclePrice,
  type OraclePrice,
  type OracleProvider,
} from "../priceOracle";

describe("parseOraclePrice", () => {
  it("parses a numeric price and timestamp", () => {
    const result = parseOraclePrice("XLM", { price: 0.42, timestamp: 1700000000000 });
    expect(result).toEqual({ symbol: "XLM", price: 0.42, timestamp: 1700000000000 });
  });

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

describe("PriceOracle multi-provider integration", () => {
  const makeProvider = (
    name: string,
    fetch: OracleProvider["fetch"],
  ): OracleProvider => ({ name, fetch });

  it("aggregates prices across multiple providers", async () => {
    const oracle = new PriceOracle([
      makeProvider("a", async () => ({ price: 2 })),
      makeProvider("b", async () => ({ price: 4 })),
      makeProvider("c", async () => ({ price: 6 })),
    ]);
    const price = await oracle.fetchPrice("XLM");
    expect(price.price).toBe(4);
    expect(price.symbol).toBe("XLM");
  });

  it("falls back to remaining providers when one fails", async () => {
    const oracle = new PriceOracle([
      makeProvider("bad", async () => {
        throw new Error("provider down");
      }),
      makeProvider("good", async () => ({ price: 5 })),
    ]);
    const price = await oracle.fetchPrice("XLM");
    expect(price.price).toBe(5);
  });

  it("rejects invalid prices from a provider and uses valid ones", async () => {
    const oracle = new PriceOracle([
      makeProvider("invalid", async () => ({ price: -1 })),
      makeProvider("valid", async () => ({ price: 3 })),
    ]);
    const price = await oracle.fetchPrice("XLM");
    expect(price.price).toBe(3);
  });

  it("throws when all providers fail", async () => {
    const oracle = new PriceOracle([
      makeProvider("a", async () => {
        throw new Error("down");
      }),
      makeProvider("b", async () => ({ price: 0 })),
    ]);
    await expect(oracle.fetchPrice("XLM")).rejects.toThrow(/No valid oracle price/);
  });

  it("enforces rate limiting between fetches", async () => {
    const oracle = new PriceOracle(
      [makeProvider("a", async () => ({ price: 1 }))],
      { minIntervalMs: 1000 },
    );
    await oracle.fetchPrice("XLM");
    await expect(oracle.fetchPrice("XLM")).rejects.toThrow(/rate limit/i);
  });

  it("reports provider health for monitoring", async () => {
    const oracle = new PriceOracle([
      makeProvider("ok", async () => ({ price: 2 })),
      makeProvider("bad", async () => {
        throw new Error("down");
      }),
    ]);
    await oracle.fetchPrice("XLM");
    const health = oracle.getProviderHealth();
    expect(health.find((h) => h.name === "ok")?.healthy).toBe(true);
    expect(health.find((h) => h.name === "bad")?.healthy).toBe(false);
  });
});
