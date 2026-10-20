import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { estimateSwapOutput } from "../ammCalculator.js";
import { InsufficientLiquidityError } from "../errors.js";

// ---------------------------------------------------------------------------
// Constant-product invariant preservation (issue #683)
// ---------------------------------------------------------------------------

function makePool(reserveIn: string, reserveOut: string) {
  return {
    reserves: [
      { asset: "XLM", amount: reserveIn },
      { asset: "USDC", amount: reserveOut },
    ],
  };
}

describe("constant-product invariant preservation", () => {
  it("preserves k = reserveA * reserveB after a simulated swap", () => {
    const reserveIn = 1_000_000_000_000n;
    const reserveOut = 500_000_000_000n;
    const pool = makePool(reserveIn.toString(), reserveOut.toString());
    const k = reserveIn * reserveOut;

    const inputAmount = 10_000_000n;
    const result = estimateSwapOutput(pool, inputAmount.toString(), "XLM");

    const newReserveIn = reserveIn + inputAmount;
    const newReserveOut = reserveOut - BigInt(result.outputAmount);
    const newK = newReserveIn * newReserveOut;

    // Integer-division rounding means newK can only ever be <= k, and the
    // relative drift must stay within a tight tolerance (no fee/rounding bug
    // can silently break the invariant).
    expect(newK).toBeLessThanOrEqual(k);
    const drift = k - newK;
    const tolerance = k / 1_000_000n; // 0.0001% relative tolerance
    expect(drift).toBeLessThanOrEqual(tolerance);
  });

  it("holds across a range of input sizes", () => {
    const reserveIn = 250_000_000_000n;
    const reserveOut = 250_000_000_000n;
    const pool = makePool(reserveIn.toString(), reserveOut.toString());
    const k = reserveIn * reserveOut;

    for (const inputAmount of [1n, 1_000n, 1_000_000n, 50_000_000_000n]) {
      const result = estimateSwapOutput(pool, inputAmount.toString(), "XLM");
      const newReserveIn = reserveIn + inputAmount;
      const newReserveOut = reserveOut - BigInt(result.outputAmount);
      const newK = newReserveIn * newReserveOut;

      expect(newK).toBeLessThanOrEqual(k);
      const drift = k - newK;
      const tolerance = k / 1_000_000n;
      expect(drift).toBeLessThanOrEqual(tolerance);
    }
  });

  it("throws InsufficientLiquidityError for a swap larger than available reserves", () => {
    const pool = makePool("1000", "1000");
    expect(() => estimateSwapOutput(pool, "1000000", "XLM")).toThrow(
      InsufficientLiquidityError,
    );
  });

  it("returns 0 received and leaves reserves unchanged for a zero-amount swap", () => {
    const reserveIn = 1_000_000n;
    const reserveOut = 2_000_000n;
    const pool = makePool(reserveIn.toString(), reserveOut.toString());

    const result = estimateSwapOutput(pool, "0", "XLM");

    expect(result.outputAmount).toBe("0");
    // Reserves reported back on the pool object itself are untouched — the
    // function is pure and never mutates its input.
    expect(pool.reserves[0]!.amount).toBe(reserveIn.toString());
    expect(pool.reserves[1]!.amount).toBe(reserveOut.toString());
  });
});

// ---------------------------------------------------------------------------
// Property-based testing framework (issue #1188)
//
// Uses fast-check to generate arbitrary pool reserves and swap inputs, then
// asserts invariants that must hold for every valid swap. fast-check's built-in
// shrinking automatically minimizes any counterexample it finds, and the
// reporter below surfaces the shrunk case plus a short analysis so failures are
// actionable.
// ---------------------------------------------------------------------------

// Generator for a positive bigint reserve, biased toward realistic magnitudes.
const reserveArb: fc.Arbitrary<bigint> = fc
  .oneof(
    fc.bigInt({ min: 1n, max: 1_000_000n }),
    fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
    fc.bigInt({ min: 1n, max: 10n ** 24n }),
  )
  .map((n) => (n < 1n ? 1n : n));

// Generator for a swap input that is strictly smaller than the input reserve,
// so the swap is always valid (never exceeds available liquidity).
const swapArb = (reserveIn: bigint): fc.Arbitrary<bigint> =>
  fc.bigInt({ min: 0n, max: reserveIn - 1n });

interface SwapCase {
  reserveIn: bigint;
  reserveOut: bigint;
  inputAmount: bigint;
}

const swapCaseArb: fc.Arbitrary<SwapCase> = reserveArb.chain((reserveIn) =>
  fc.record({
    reserveIn: fc.constant(reserveIn),
    reserveOut: reserveArb,
    inputAmount: swapArb(reserveIn),
  }),
);

// Result reporting: turn a shrunk counterexample into a readable message.
function reportCase(c: SwapCase): string {
  return [
    `reserveIn=${c.reserveIn}`,
    `reserveOut=${c.reserveOut}`,
    `inputAmount=${c.inputAmount}`,
  ].join(" ");
}

// Property analysis: derive the expected output bounds for a case so failures
// explain *why* the invariant was violated, not just that it was.
function analyze(c: SwapCase, output: bigint): string {
  const k = c.reserveIn * c.reserveOut;
  const newK = (c.reserveIn + c.inputAmount) * (c.reserveOut - output);
  return [
    reportCase(c),
    `output=${output}`,
    `k=${k}`,
    `newK=${newK}`,
    `drift=${k - newK}`,
  ].join(" ");
}

describe("property-based: constant-product invariants", () => {
  it("never increases k and keeps drift within tolerance for any valid swap", () => {
    fc.assert(
      fc.property(swapCaseArb, (c) => {
        const pool = makePool(c.reserveIn.toString(), c.reserveOut.toString());
        const result = estimateSwapOutput(
          pool,
          c.inputAmount.toString(),
          "XLM",
        );
        const output = BigInt(result.outputAmount);

        const k = c.reserveIn * c.reserveOut;
        const newK = (c.reserveIn + c.inputAmount) * (c.reserveOut - output);
        const tolerance = k / 1_000_000n;

        if (newK > k || k - newK > tolerance) {
          throw new Error(`invariant violated: ${analyze(c, output)}`);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("never returns more than the available output reserve", () => {
    fc.assert(
      fc.property(swapCaseArb, (c) => {
        const pool = makePool(c.reserveIn.toString(), c.reserveOut.toString());
        const result = estimateSwapOutput(
          pool,
          c.inputAmount.toString(),
          "XLM",
        );
        const output = BigInt(result.outputAmount);

        if (output < 0n || output >= c.reserveOut) {
          throw new Error(`output out of bounds: ${analyze(c, output)}`);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("is monotonic: larger inputs never yield smaller outputs", () => {
    fc.assert(
      fc.property(
        reserveArb,
        reserveArb,
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        (reserveIn, reserveOut, a, b) => {
          const small = a < b ? a : b;
          const large = a < b ? b : a;
          if (large >= reserveIn) return true; // skip invalid swaps

          const pool = makePool(reserveIn.toString(), reserveOut.toString());
          const outSmall = BigInt(
            estimateSwapOutput(pool, small.toString(), "XLM").outputAmount,
          );
          const outLarge = BigInt(
            estimateSwapOutput(pool, large.toString(), "XLM").outputAmount,
          );

          if (outLarge < outSmall) {
            throw new Error(
              `monotonicity violated: small=${small}->${outSmall} large=${large}->${outLarge} reserveIn=${reserveIn} reserveOut=${reserveOut}`,
            );
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("is pure: never mutates the input pool", () => {
    fc.assert(
      fc.property(swapCaseArb, (c) => {
        const pool = makePool(c.reserveIn.toString(), c.reserveOut.toString());
        estimateSwapOutput(pool, c.inputAmount.toString(), "XLM");

        if (
          pool.reserves[0]!.amount !== c.reserveIn.toString() ||
          pool.reserves[1]!.amount !== c.reserveOut.toString()
        ) {
          throw new Error(`pool mutated: ${reportCase(c)}`);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});
