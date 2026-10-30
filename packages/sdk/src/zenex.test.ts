import { describe, it, expect } from "vitest";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { Spec } from "@stellar/stellar-sdk/contract";
import {
  decodeFullReport,
  encodeZenexCloseRequest,
  encodeZenexOpenRequest,
  inspectZenexInterface,
} from "./zenex.js";
import { ZENEX_SPEC_ENTRIES } from "./generated/zenex-v1.js";
describe("experimental venue-accounted perpetual integration", () => {
  it("encodes real Soroban request bytes and rejects decoded-price substitutes", () => {
    const bytes = decodeFullReport("0x1234abcd");
    const encoded = encodeZenexCloseRequest(bytes);
    const value = scValToNative(xdr.ScVal.fromXDR(Buffer.from(encoded)));
    expect(new Uint8Array(value.price)).toEqual(bytes);
    expect(value.price_bound).toBe(0n);
    expect(() => decodeFullReport("159.4")).toThrow();
    expect(() => decodeFullReport("aa".repeat(12001))).toThrow();
    expect(() =>
      encodeZenexOpenRequest({
        isLong: true,
        notional: 100n,
        priceBound: 0n,
        price: bytes,
      }),
    ).toThrow("price bound");
    const open = scValToNative(
      xdr.ScVal.fromXDR(
        Buffer.from(
          encodeZenexOpenRequest({
            isLong: false,
            notional: 100n,
            priceBound: 200n,
            price: bytes,
          }),
        ),
      ),
    );
    expect(open.is_long).toBe(false);
    expect(open.notional).toBe(100n);
  });
  it("never turns interface inspection into a live protocol admission", () => {
    const own = new Spec(Array.from(ZENEX_SPEC_ENTRIES.zenex_vault));
    const getter = xdr.ScSpecEntry.scSpecEntryFunctionV0(
      new xdr.ScSpecFunctionV0({
        doc: "",
        name: "get_trader_state",
        inputs: [
          new xdr.ScSpecFunctionInputV0({
            doc: "",
            name: "user",
            type: xdr.ScSpecTypeDef.scSpecTypeAddress(),
          }),
        ],
        outputs: [
          xdr.ScSpecTypeDef.scSpecTypeUdt(
            new xdr.ScSpecTypeUdt({ name: "TraderState" }),
          ),
        ],
      }),
    );
    const compatible = inspectZenexInterface([
      ...own.entries.map((e) => e.toXDR("base64")),
      getter.toXDR("base64"),
    ]);
    expect(compatible.interfaceCompatible).toBe(true);
    expect(compatible.liveAdmitted).toBe(false);
    const missing = inspectZenexInterface(ZENEX_SPEC_ENTRIES.zenex_vault);
    expect(missing.interfaceCompatible).toBe(false);
    expect(missing.reasons[0]).toContain("get_trader_state");
  });
});
