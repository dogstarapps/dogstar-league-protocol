import { seed, encode, decode, type World } from '../../core/src/index.js';
import { drain } from './runner.js';
import { readFile, writeFile } from 'node:fs/promises';
const file = process.argv.find((a) => a.startsWith('--state='))?.slice(8);
let state = file ? decode<World>(await readFile(file, 'utf8')) : seed();
if (process.argv.includes('--end'))
  state.now = Math.max(...state.rounds.map((r) => r.config.calendar.end));
const result = drain(state);
if (file && process.argv.includes('--write'))
  await writeFile(file, encode(result.state), { flag: 'w' });
console.log(
  JSON.stringify(
    {
      mode: 'LOCAL_SIMULATION',
      persisted: !!file && process.argv.includes('--write'),
      progressed: result.progressed,
      failures: result.failures,
      rounds: result.state.rounds.map((r) => ({
        id: r.config.id,
        phase: r.phase,
        residuals: r.residuals.length,
      })),
    },
    null,
    2,
  ),
);
