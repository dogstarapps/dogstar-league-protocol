import { execute, plan } from './engine.js';
import type { World } from './types.js';
/** Browser-safe reference execution over explicit simulation state. */
export function runOnce(input: World, operator = 'DEMO_EXECUTOR') {
  let state = structuredClone(input);
  let progressed = 0;
  const failures: string[] = [];
  for (const round of state.rounds) {
    for (const command of plan(state, round)) {
      try {
        state = execute(state, round.config.id, operator, command);
        progressed++;
      } catch (error) {
        failures.push(
          `${round.config.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return { state, progressed, failures };
}
export function drain(input: World, operator = 'DEMO_EXECUTOR') {
  let result = runOnce(input, operator),
    total = result.progressed;
  for (let i = 0; i < 1000 && result.progressed; i++) {
    const next = runOnce(result.state, operator);
    total += next.progressed;
    result = { ...next, failures: [...result.failures, ...next.failures] };
  }
  return { ...result, progressed: total };
}
