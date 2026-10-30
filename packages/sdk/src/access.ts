import { StrKey } from "@stellar/stellar-sdk";
import type { AccessRule, RoundAccess, RoundConfig } from "./types.js";

export function validateAccessRule(rule: AccessRule): AccessRule {
  if (rule?.tag === "Open" || rule?.tag === "CreatorOnly") return rule;
  if (
    rule?.tag !== "Allowlist" ||
    !Array.isArray(rule.values) ||
    rule.values.length !== 1
  )
    throw new Error("Invalid round access rule.");
  const wallets = rule.values[0];
  if (!Array.isArray(wallets) || !wallets.length || wallets.length > 100)
    throw new Error(
      "An invitation list needs between 1 and 100 wallet addresses.",
    );
  if (new Set(wallets).size !== wallets.length)
    throw new Error(
      "Remove duplicate wallet addresses from the invitation list.",
    );
  if (
    wallets.some(
      (w) =>
        typeof w !== "string" ||
        (!StrKey.isValidEd25519PublicKey(w) && !StrKey.isValidContract(w)),
    )
  )
    throw new Error(
      "Invitation lists must contain valid Stellar account or contract addresses.",
    );
  return rule;
}
export function parseAccessRule(
  mode: AccessRule["tag"],
  text = "",
): AccessRule {
  return validateAccessRule(
    mode === "Allowlist"
      ? {
          tag: mode,
          values: [text.trim() ? text.trim().split(/[\s,;]+/u) : []],
        }
      : { tag: mode },
  );
}
export function validateRoundAccess(
  access: RoundAccess,
  minPlayers?: number,
): RoundAccess {
  if (!access)
    throw new Error("This round is missing its immutable access rules.");
  validateAccessRule(access.funding);
  validateAccessRule(access.participation);
  const capacity =
    access.participation.tag === "CreatorOnly"
      ? 1
      : access.participation.tag === "Allowlist"
        ? access.participation.values[0].length
        : undefined;
  if (
    minPlayers !== undefined &&
    (!Number.isSafeInteger(minPlayers) ||
      minPlayers < 1 ||
      (capacity !== undefined && capacity < minPlayers))
  )
    throw new Error(
      "The invitation list cannot supply the minimum number of players.",
    );
  return access;
}
export function roundAccess(
  config: Pick<RoundConfig, "access" | "min_players">,
  protocolVersion?: string,
): RoundAccess {
  // Earlier immutable contracts enforce open access even if an untrusted API adds new fields.
  if (protocolVersion !== "0.6.0")
    return { funding: { tag: "Open" }, participation: { tag: "Open" } };
  return validateRoundAccess(config.access!, config.min_players);
}
export function accessAllows(
  rule: AccessRule,
  creator: string,
  wallet: string,
): boolean {
  validateAccessRule(rule);
  return (
    rule.tag === "Open" ||
    (rule.tag === "CreatorOnly"
      ? wallet === creator
      : rule.values[0].includes(wallet))
  );
}
