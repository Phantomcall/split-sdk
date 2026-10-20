import { describe, it, expect, beforeEach, vi } from "vitest";
import fc from "fast-check";
import { StellarSplitClient } from "../client.js";
import { TypedEventEmitter } from "../events/TypedEventEmitter.js";
import { MetricsPlugin, PluginRegistry } from "../plugin.js";
import { BatchTooLargeError } from "../errors.js";
import type { CreateInvoiceParams } from "../types.js";

// Property-based testing configuration (#1188).
// fast-check provides generators and integrated shrinking so failing
// properties are minimized to the smallest counterexample.
const PROPERTY_RUNS = 100;
const fcConfig = { numRuns: PROPERTY_RUNS };

// Generators for relevant input domains.
const bigintArb = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });
const invoiceIdArb = fc.bigInt({ min: 1n, max: 2n ** 32n - 1n });
const eventNameArb = fc.constantFrom("batch:created", "payment", "test");
const methodNameArb = fc.constantFrom("createInvoice", "pay", "release", "refund");
const pluginNameArb = fc.string({ minLength: 1, maxLength: 32 });

// Result reporting helper: surfaces the shrunk counterexample clearly.
function reportProperty(name: string, result: fc.RunDetails<unknown>): void {
  if (result.failed) {
    // eslint-disable-next-line no-console
    console.error(
      `[property:${name}] failed after ${result.numRuns} runs; ` +
        `shrunk counterexample: ${JSON.stringify(result.counterexample, (_k, v) =>
          typeof v === "bigint" ? `${v}n` : v,
        )}`,
    );
  }
}

describe("SDK Features (#854, #855, #856, #857)", () => {
  // Mock config
  const config = {
    rpcUrl: "http://localhost:8000",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CBND2TWUC3BVVK4IEUA6O3DC7RNWXO5EAUWK5F2BXBDKP2I7BLXVKZDS",
  };

  describe("Issue #855 - batchCreateInvoices", () => {
    it("should validate batch size limit (1-20)", () => {
      const client = new StellarSplitClient(config);
      expect(() => client.batchCreateInvoices([])).rejects.toThrow(BatchTooLargeError);
      expect(() => client.batchCreateInvoices(Array(21).fill({}))).rejects.toThrow(BatchTooLargeError);
    });

    it("should validate all invoices before RPC call", async () => {
      const client = new StellarSplitClient(config);
      const invoices: CreateInvoiceParams[] = [
        { creator: "test", token: "test", deadline: 1000, recipients: [] },
        { creator: "", token: "test", deadline: 1000, recipients: [] },
      ];

      expect(() => client.batchCreateInvoices(invoices)).rejects.toThrow();
    });
  });

  describe("Issue #856 - SDK Event Bus", () => {
    it("should support typed event subscription", () => {
      const emitter = new TypedEventEmitter<{
        "batch:created": { invoiceIds: bigint[] };
        payment: { invoiceId: bigint; amount: bigint };
      }>();

      const handler = vi.fn();
      emitter.on("batch:created", handler);
      emitter.emit("batch:created", { invoiceIds: [1n, 2n] });

      expect(handler).toHaveBeenCalledWith({ invoiceIds: [1n, 2n] });
    });

    it("should support unsubscribing from events", () => {
      const emitter = new TypedEventEmitter<{ test: { value: number } }>();
      const handler = vi.fn();
      const unsubscribe = emitter.on("test", handler);

      emitter.emit("test", { value: 1 });
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      emitter.emit("test", { value: 2 });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should support once for single-fire subscriptions", async () => {
      const emitter = new TypedEventEmitter<{ test: { value: number } }>();

      const promise = emitter.once("test");
      emitter.emit("test", { value: 42 });

      const result = await promise;
      expect(result).toEqual({ value: 42 });
    });
  });

  describe("Issue #857 - Plugin System", () => {
    it("should prevent duplicate plugin registration", () => {
      const registry = new PluginRegistry();
      const plugin = {
        name: "TestPlugin",
        beforeCall: (method: any, args: any) => args,
      };

      registry.use(plugin);
      expect(() => registry.use(plugin)).toThrow();
    });

    it("should support fluent API for plugin chaining", () => {
      const client = new StellarSplitClient(config);
      const plugin = { name: "Test", install: vi.fn() };

      const result = client.use(plugin);
      expect(result).toBe(client);
    });

    it("should call plugin install method with client context", () => {
      const client = new StellarSplitClient(config);
      const installFn = vi.fn();
      const plugin = { name: "TestPlugin", install: installFn };

      client.use(plugin);
      expect(installFn).toHaveBeenCalledWith(expect.objectContaining({ on: expect.any(Function), off: expect.any(Function) }));
    });

    it("should allow plugin to unsubscribe", () => {
      const registry = new PluginRegistry();
      const plugin = { name: "TestPlugin" };

      registry.use(plugin);
      expect(registry.getPlugins()).toContain("TestPlugin");

      registry.removePlugin("TestPlugin");
      expect(registry.getPlugins()).not.toContain("TestPlugin");
    });
  });

  describe("MetricsPlugin", () => {
    it("should track method call counts", () => {
      const plugin = new MetricsPlugin();
      const metrics = plugin.getMetrics();

      expect(metrics).toEqual({});

      plugin.afterCall("createInvoice", { invoiceId: "test", txHash: "hash" });
      expect(plugin.getMetrics()).toEqual({ createInvoice: 1 });

      plugin.afterCall("createInvoice", { invoiceId: "test2", txHash: "hash2" });
      expect(plugin.getMetrics()).toEqual({ createInvoice: 2 });
    });

    it("should reset metrics", () => {
      const plugin = new MetricsPlugin();
      plugin.afterCall("pay", { txHash: "hash" });

      expect(plugin.getMetrics()).toEqual({ pay: 1 });
      plugin.resetMetrics();
      expect(plugin.getMetrics()).toEqual({});
    });
  });

  describe("Contract Events", () => {
    it("should have typed payment event", () => {
      const event: import("../contractEvents.js").PaymentEvent = {
        invoiceId: 1n,
        amount: 100n,
        payer: "test",
        timestamp: Date.now(),
      };
      expect(event.invoiceId).toBe(1n);
    });

    it("should have typed release event", () => {
      const event: import("../contractEvents.js").ReleaseEvent = {
        invoiceId: 1n,
        amount: 100n,
        recipient: "test",
        timestamp: Date.now(),
      };
      expect(event.amount).toBe(100n);
    });
  });

  describe("Creator Stats", () => {
    it("should have CreatorStats type with all fields", () => {
      const stats: import("../creatorStats.js").CreatorStats = {
        totalInvoices: 10,
        totalRaised: 1000n,
        totalReleased: 900n,
        totalRefunded: 0n,
        successRate: 90,
        averageFundingTimeHours: 2.5,
        uniquePayerCount: 5,
        averageRating: 4.5,
      };
      expect(stats.successRate).toBe(90);
      expect(stats.totalInvoices).toBe(10);
    });

    it("should have all required fields", () => {
      const stats: import("../creatorStats.js").CreatorStats = {
        totalInvoices: 5,
        totalRaised: 500n,
        totalReleased: 500n,
        totalRefunded: 0n,
        successRate: 100,
        averageFundingTimeHours: 1,
        uniquePayerCount: 3,
        averageRating: 5,
      };
      expect(stats.totalInvoices).toBe(5);
      expect(stats.successRate).toBe(100);
    });
  });

  describe("Property-based tests (#1188)", () => {
    it("event bus delivers every emitted payload to all subscribers", () => {
      const result = fc.check(
        fc.property(
          eventNameArb,
          fc.array(fc.integer(), { maxLength: 5 }),
          (eventName, payloads) => {
            const emitter = new TypedEventEmitter<Record<string, unknown>>();
            const received: unknown[] = [];
            emitter.on(eventName, (p) => received.push(p));
            for (const p of payloads) emitter.emit(eventName, p);
            expect(received).toEqual(payloads);
          },
        ),
        fcConfig,
      );
      reportProperty("event-bus-delivery", result);
      expect(result.failed).toBe(false);
    });

    it("unsubscribe stops delivery regardless of emit count", () => {
      const result = fc.check(
        fc.property(
          eventNameArb,
          fc.integer({ min: 0, max: 20 }),
          fc.integer({ min: 0, max: 20 }),
          (eventName, before, after) => {
            const emitter = new TypedEventEmitter<Record<string, unknown>>();
            const handler = vi.fn();
            const unsubscribe = emitter.on(eventName, handler);
            for (let i = 0; i < before; i++) emitter.emit(eventName, i);
            unsubscribe();
            for (let i = 0; i < after; i++) emitter.emit(eventName, i);
            expect(handler).toHaveBeenCalledTimes(before);
          },
        ),
        fcConfig,
      );
      reportProperty("unsubscribe", result);
      expect(result.failed).toBe(false);
    });

    it("metrics counts equal number of recorded calls per method", () => {
      const result = fc.check(
        fc.property(
          fc.array(methodNameArb, { maxLength: 30 }),
          (calls) => {
            const plugin = new MetricsPlugin();
            for (const m of calls) plugin.afterCall(m, { txHash: "h" });
            const metrics = plugin.getMetrics();
            const expected: Record<string, number> = {};
            for (const m of calls) expected[m] = (expected[m] ?? 0) + 1;
            expect(metrics).toEqual(expected);
          },
        ),
        fcConfig,
      );
      reportProperty("metrics-counts", result);
      expect(result.failed).toBe(false);
    });

    it("resetMetrics always yields empty metrics", () => {
      const result = fc.check(
        fc.property(fc.array(methodNameArb, { maxLength: 20 }), (calls) => {
          const plugin = new MetricsPlugin();
          for (const m of calls) plugin.afterCall(m, { txHash: "h" });
          plugin.resetMetrics();
          expect(plugin.getMetrics()).toEqual({});
        }),
        fcConfig,
      );
      reportProperty("metrics-reset", result);
      expect(result.failed).toBe(false);
    });

    it("plugin registry tracks exactly the registered plugin names", () => {
      const result = fc.check(
        fc.property(fc.uniqueArray(pluginNameArb, { maxLength: 10 }), (names) => {
          const registry = new PluginRegistry();
          for (const name of names) registry.use({ name });
          expect(registry.getPlugins().sort()).toEqual([...names].sort());
        }),
        fcConfig,
      );
      reportProperty("plugin-registry", result);
      expect(result.failed).toBe(false);
    });

    it("batch size validation rejects out-of-range sizes", () => {
      const result = fc.check(
        fc.property(fc.integer({ min: 0, max: 40 }), (size) => {
          const client = new StellarSplitClient(config);
          const invoices = Array.from({ length: size }, () => ({})) as CreateInvoiceParams[];
          const inRange = size >= 1 && size <= 20;
          if (inRange) {
            // In-range batches proceed past the size guard (may fail later on
            // validation/RPC, but must not throw BatchTooLargeError).
            expect(() => client.batchCreateInvoices(invoices)).not.toThrow(BatchTooLargeError);
          } else {
            expect(() => client.batchCreateInvoices(invoices)).rejects.toThrow(BatchTooLargeError);
          }
        }),
        fcConfig,
      );
      reportProperty("batch-size", result);
      expect(result.failed).toBe(false);
    });

    it("bigint invoice ids round-trip through event payloads", () => {
      const result = fc.check(
        fc.property(invoiceIdArb, bigintArb, (invoiceId, amount) => {
          const emitter = new TypedEventEmitter<{
            payment: { invoiceId: bigint; amount: bigint };
          }>();
          let received: { invoiceId: bigint; amount: bigint } | undefined;
          emitter.on("payment", (p) => (received = p));
          emitter.emit("payment", { invoiceId, amount });
          expect(received).toEqual({ invoiceId, amount });
        }),
        fcConfig,
      );
      reportProperty("bigint-roundtrip", result);
      expect(result.failed).toBe(false);
    });
  });
});
