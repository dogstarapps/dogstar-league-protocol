import { Address, nativeToScVal } from '@stellar/stellar-sdk';
import { TestnetClient } from '../../sdk/src/testnet.js';
const option = (name: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const contractId = option('contract'),
  source = option('source');
if (!contractId || !source) {
  console.log(
    'Usage: npm run executor:testnet:plan -- --contract=C... --source=G... [--rpc=https://...]\nRead-only Testnet planner. No secrets, signing or submission.',
  );
  process.exit(0);
}
const client = new TestnetClient({ contractId, source, rpcUrl: option('rpc') });
const phase = Number(await client.read('phase')),
  config = await client.read('config'),
  totals = await client.read('totals');
const timestamp = Math.floor(Date.now() / 1000);
const task: string[] = [];
const due = [
  config.calendar.funding_close,
  config.calendar.registration_close,
  config.calendar.start,
  config.calendar.end,
];
if (phase < 4 && timestamp >= Number(due[phase])) task.push('advance(operator)');
if (phase === 4) {
  if (totals.open_orders > 0)
    for (let id = 1; id <= Math.min(totals.next_order, 200); id++) {
      const o = await client.read('order', [nativeToScVal(id, { type: 'u32' })]);
      if (o.open && timestamp >= Number(o.expires)) task.push(`cancel_limit(${id})`);
    }
  if (totals.open_orders === 0) {
    const players = (await client.read('registrations')) as string[];
    for (const p of players) {
      const reg = await client.read('registration', [new Address(p).toScVal()]);
      if (!reg.confirmed) continue;
      const player = await client.read('player', [new Address(p).toScVal()]);
      if (player.settled) continue;
      const pending = [];
      for (const asset of config.assets as string[]) {
        if (asset === config.cash) continue;
        const balance = await client.read('balance', [
          new Address(p).toScVal(),
          new Address(asset).toScVal(),
        ]);
        if (balance > 0n) pending.push(asset);
      }
      task.push(
        pending.length
          ? `Needs admitted route and independent quote: ${p} / ${pending.join(',')}`
          : `settle_player(${p},operator)`,
      );
    }
  }
  if (totals.settled === totals.players) task.push('finalize(operator)');
}
console.log(
  JSON.stringify(
    {
      network: 'TESTNET',
      mode: 'READ_ONLY_PLAN',
      phase,
      contractId,
      clock: 'Host clock proposes; ledger timestamp validates',
      tasks: task,
    },
    null,
    2,
  ),
);
