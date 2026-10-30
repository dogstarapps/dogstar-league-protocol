import type { RoundSnapshot } from "../../sdk/src/types.js";
export interface Task {
  round: string;
  method: string;
  args: Record<string, unknown>;
  key: string;
  target?: "factory";
  maintenance?: boolean;
}
export function transitionTask(
  s: RoundSnapshot,
  now: bigint,
  operator: string,
): Task | undefined {
  const c = s.config.calendar;
  const deadline =
    s.phase === 0
      ? c.funding_close
      : s.phase === 1
        ? c.registration_close
        : s.phase === 2
          ? c.start
          : s.phase === 3
            ? c.end
            : undefined;
  if (deadline !== undefined && now >= deadline)
    return {
      round: s.address,
      method: "advance",
      args: { operator },
      key: `${s.address}:advance:${s.phase}`,
    };
  if (
    s.phase === 4 &&
    s.totals.settled === s.totals.players &&
    s.totals.open_orders === 0
  )
    return {
      round: s.address,
      method: "finalize",
      args: { operator },
      key: `${s.address}:finalize`,
    };
  return undefined;
}
