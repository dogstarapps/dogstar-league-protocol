import { xdr } from "@stellar/stellar-sdk";
import { Spec } from "@stellar/stellar-sdk/contract";
import {
  ZENEX_SPEC_ENTRIES,
  ZENEX_BUILD_ARTIFACTS,
} from "./generated/zenex-v1.js";
export { ZENEX_BUILD_ARTIFACTS };
const spec = new Spec(Array.from(ZENEX_SPEC_ENTRIES.zenex_vault));
const type = (name: string) =>
  xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name }));
export interface ZenexSettings {
  cash: string;
  settlement: string;
  market: string;
  market_hash: Uint8Array;
  swap_adapter: string;
  swap_hash: Uint8Array;
  vault_wasm: Uint8Array;
  max_leverage_bps: number;
  close_fee_reserve: bigint;
}
export interface ZenexTraderState {
  version: number;
  epoch: Uint8Array;
  sequence: bigint;
  paid: bigint;
  credit: bigint;
  long_notional: bigint;
  short_notional: bigint;
  pending_orders: number;
}
export function decodeFullReport(value: string): Uint8Array {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (
    !hex.length ||
    hex.length > 24000 ||
    hex.length % 2 ||
    !/^[a-fA-F0-9]+$/.test(hex)
  )
    throw new Error(
      "Provide the complete bounded hexadecimal signed price report.",
    );
  return Uint8Array.from(hex.match(/../g)!.map((n) => parseInt(n, 16)));
}
export function encodeZenexCloseRequest(price: Uint8Array, priceBound = 0n) {
  if (!price.length || price.length > 12000 || priceBound < 0n)
    throw new Error("Invalid close report or bound.");
  return new Uint8Array(
    spec
      .nativeToScVal({ price, price_bound: priceBound }, type("CloseRequest"))
      .toXDR(),
  );
}
export function encodeZenexOpenRequest(input: {
  isLong: boolean;
  notional: bigint;
  priceBound: bigint;
  price: Uint8Array;
}) {
  if (
    typeof input.isLong !== "boolean" ||
    input.notional <= 0n ||
    input.priceBound <= 0n ||
    !input.price.length ||
    input.price.length > 12000
  )
    throw new Error(
      "An opening requires positive notional, a price bound and a complete signed report.",
    );
  return new Uint8Array(
    spec
      .nativeToScVal(
        {
          is_long: input.isLong,
          notional: input.notional,
          price_bound: input.priceBound,
          price: input.price,
        },
        type("OpenRequest"),
      )
      .toXDR(),
  );
}
export function inspectZenexInterface(entries: readonly string[]) {
  const candidate = new Spec(Array.from(entries));
  const getter = candidate
    .funcs()
    .find((f) => f.name.toString() === "get_trader_state");
  const reasons: string[] = [];
  if (!getter)
    reasons.push(
      "The venue does not expose get_trader_state with authenticated cumulative trader payments.",
    );
  else {
    if (
      getter.inputs.length !== 1 ||
      getter.inputs[0].type.type !== "scSpecTypeAddress" ||
      getter.outputs.length !== 1 ||
      getter.outputs[0].type !== "scSpecTypeUdt" ||
      getter.outputs[0].udt.name.toString() !== "TraderState"
    )
      reasons.push(
        "The venue accounting getter has an incompatible signature.",
      );
    try {
      const actual = candidate.findEntry("TraderState"),
        expected = spec.findEntry("TraderState");
      if (
        actual.type !== "scSpecEntryUdtStructV0" ||
        expected.type !== "scSpecEntryUdtStructV0"
      )
        throw new Error("Wrong accounting type.");
      const fields = (entry: typeof actual) =>
        entry.type === "scSpecEntryUdtStructV0"
          ? entry.udtStructV0.fields.map((f) => [
              f.name.toString(),
              f.type.toXDR("base64"),
            ])
          : [];
      if (JSON.stringify(fields(actual)) !== JSON.stringify(fields(expected)))
        reasons.push("The accounting fields differ from the required ABI 1.");
    } catch {
      reasons.push(
        "The venue does not expose the required TraderState schema.",
      );
    }
  }
  return {
    interfaceCompatible: reasons.length === 0,
    requiredAccountingVersion: 1,
    liveAdmitted: false as const,
    reasons,
  };
}
