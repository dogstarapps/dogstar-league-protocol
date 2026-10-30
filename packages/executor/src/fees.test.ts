import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFee, type FeePolicy } from "./fees.js";
import { Journal } from "./journal.js";
const policy: FeePolicy = {
  maxFee: 100n,
  totalFeeBudget: 150n,
  minSurplus: 10n,
  allowUnprofitable: false,
};
describe("operator-owned gas controls", () => {
  it("requires reward coverage and surplus unless a bounded maintenance allowance is explicit", () => {
    expect(() => checkFee(90n, 100n, policy)).not.toThrow();
    expect(() => checkFee(91n, 100n, policy)).toThrow("surplus");
    expect(() => checkFee(101n, 1000n, policy)).toThrow("fee cap");
    expect(() =>
      checkFee(90n, 0n, { ...policy, allowUnprofitable: true }),
    ).not.toThrow();
    expect(() =>
      checkFee(101n, 0n, { ...policy, allowUnprofitable: true }),
    ).toThrow("fee cap");
  });
  it("atomically records signed-envelope fees, survives restart and never releases ambiguous spend", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "dogstar-fee-test-")),
      "journal.sqlite",
    );
    const task = {
      round: "round",
      method: "advance",
      args: { operator: "operator" },
      key: "round:advance:0",
    };
    let journal = new Journal(path, "operator");
    journal.save(
      task,
      { hash: "first", signedXdr: "envelope-one", expiresAt: 1000 },
      90n,
      150n,
    );
    journal.close();
    journal = new Journal(path, "operator");
    try {
      expect(journal.feeAllocated()).toBe(90n);
      expect(() =>
        journal.save(
          task,
          { hash: "second", signedXdr: "envelope-two", expiresAt: 1001 },
          61n,
          150n,
        ),
      ).toThrow("budget");
      expect(journal.pending()).toHaveLength(1);
      expect(journal.feeAllocated()).toBe(90n);
      journal.finish("first", "EXPIRED");
      expect(journal.feeAllocated()).toBe(90n);
      journal.save(
        task,
        { hash: "second", signedXdr: "envelope-two", expiresAt: 1001 },
        60n,
        150n,
      );
      expect(journal.feeAllocated()).toBe(150n);
    } finally {
      journal.close();
    }
  });
});
