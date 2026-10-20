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

  it("parses string prices and aliases", () => {
    const result = parseOraclePrice("USDC", { value: "1.01", time: 1700000000000 });
    expect(result.price).toBe(1.01);
    expect(result.timestamp).toBe(1700000000000);
  });

  it("falls back to the current time when no timestamp is present", () => {
    const before = Date.now();
    const result = parseOraclePrice("XLM", { amount: 2 });
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("throws on an invalid price", () => {
    expect(() => parseOraclePrice("XLM", { price: "not-a-number" })).toThrow(
      /Invalid oracle price/,
    );
    expect(() => parseOraclePrice("XLM", {})).toThrow(/Invalid oracle price/);
  });
});

describe("PriceOracle", () => {
  it("fetches, parses, and caches a price", async () => {
    const oracle = new PriceOracle(async () => ({ price: 3.5, timestamp: 1 }));
    const price = await oracle.fetchPrice("XLM");
    expect(price).toEqual({ symbol: "XLM", price: 3.5, timestamp: 1 });
    expect(oracle.getCachedPrice("XLM")).toEqual(price);
  });

  it("emits price updates to listeners", async () => {
    const oracle = new PriceOracle(async () => ({ price: 7 }));
    const received: OraclePrice[] = [];
    const unsubscribe = oracle.onPriceUpdate((p) => received.push(p));

    await oracle.fetchPrice("XLM");
    expect(received).toHaveLength(1);
    expect(received[0].price).toBe(7);

    unsubscribe();
    await oracle.fetchPrice("XLM");
    expect(received).toHaveLength(1);
  });

  it("fetches multiple prices in order", async () => {
    const oracle = new PriceOracle(async (symbol) => ({ price: symbol.length }));
    const prices = await oracle.fetchPrices(["XLM", "USDC"]);
    expect(prices.map((p) => p.symbol)).toEqual(["XLM", "USDC"]);
    expect(prices.map((p) => p.price)).toEqual([3, 4]);
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
