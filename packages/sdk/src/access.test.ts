import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  accessAllows,
  parseAccessRule,
  roundAccess,
  validateRoundAccess,
} from "./access.js";
const creator = Keypair.random().publicKey(),
  player = Keypair.random().publicKey(),
  outsider = Keypair.random().publicKey();
describe("immutable funding and participation access", () => {
  it("requires exact public identities and rejects empty, duplicate, invalid or oversized invitation lists", () => {
    expect(parseAccessRule("Allowlist", `${creator},\n${player}`)).toEqual({
      tag: "Allowlist",
      values: [[creator, player]],
    });
    for (const text of [
      "",
      `${player} ${player}`,
      "nickname",
      Array.from({ length: 101 }, () => Keypair.random().publicKey()).join(
        "\n",
      ),
    ])
      expect(() => parseAccessRule("Allowlist", text)).toThrow();
  });
  it("keeps invitation funding distinct from creator authority and participation", () => {
    const access = {
      funding: parseAccessRule("CreatorOnly"),
      participation: parseAccessRule("Allowlist", player),
    };
    validateRoundAccess(access, 1);
    expect(accessAllows(access.funding, creator, creator)).toBe(true);
    expect(accessAllows(access.funding, creator, player)).toBe(false);
    expect(accessAllows(access.participation, creator, creator)).toBe(false);
    expect(accessAllows(access.participation, creator, player)).toBe(true);
    expect(accessAllows(access.participation, creator, outsider)).toBe(false);
    expect(() => validateRoundAccess(access, 2)).toThrow("minimum");
  });
  it("fails closed for missing current terms and never advertises restrictions on older open contracts", () => {
    expect(() => roundAccess({ min_players: 2 }, "0.6.0")).toThrow("missing");
    const config = {
      min_players: 1,
      access: {
        funding: parseAccessRule("CreatorOnly"),
        participation: parseAccessRule("Allowlist", player),
      },
    };
    expect(roundAccess(config, "0.6.0")).toEqual(config.access);
    expect(roundAccess(config, "0.5.0")).toEqual({
      funding: { tag: "Open" },
      participation: { tag: "Open" },
    });
  });
});
