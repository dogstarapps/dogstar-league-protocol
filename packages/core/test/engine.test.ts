import { describe, it, expect } from 'vitest';
import {
  amount,
  drain,
  distribute,
  encode,
  decode,
  template,
  newWorld,
  newRound,
  execute,
  requirements,
  portfolioValue,
  quote,
  type Bucket,
  type World,
  type Round,
} from '../src/index.js';
const sponsor = 'SPONSOR',
  p = 'PLAYER',
  q = 'PLAYER2',
  op = 'PUBLIC_OPERATOR';
function funded() {
  const c = template(1000, { maxPlayers: 2, minPlayers: 2, creator: sponsor });
  let w = newWorld(1000);
  w.rounds.push(newRound(c));
  for (const b of Object.keys(requirements(c)) as Bucket[])
    w = execute(w, c.id, sponsor, { type: 'contribute', bucket: b, amount: requirements(c)[b] });
  for (const wallet of [p, q])
    w = execute(w, c.id, wallet, {
      type: 'register',
      terms: w.rounds[0].terms,
      validUntil: c.calendar.preparationDeadline,
    });
  return w;
}
function active() {
  let w = funded();
  const d = w.rounds[0].config.calendar;
  for (const now of [d.fundingClose, d.registrationClose, d.start]) {
    w.now = now;
    w = execute(w, 'dl-open', op, { type: 'advance' });
  }
  return w;
}
function end(w: World) {
  w.now = w.rounds[0].config.calendar.end;
  return drain(w).state;
}
const round = (w: World): Round => w.rounds[0];
describe('per-player economics', () => {
  it('preserves individual profit when aggregate performance is flat', () => {
    let sponsorReturn = 0n,
      players = 0n;
    for (let i = 0; i < 10; i++) {
      const r = distribute(amount(i < 5 ? 120 : 80), amount(100), 10000);
      sponsorReturn += r.sponsor;
      players += r.player;
    }
    expect(sponsorReturn).toBe(amount(900));
    expect(players).toBe(amount(100));
  });
  it('conserves units and rounds down across profit shares', () => {
    for (const share of [0, 1, 3333, 7500, 10000])
      for (const recovery of [0n, 99n, 101n, 100000000000000000001n]) {
        const x = distribute(recovery, 100n, share);
        expect(x.player + x.sponsor).toBe(recovery);
        expect(x.player >= 0n).toBe(true);
      }
  });
  it('rejects exponents and avoids floating-point amounts', () => {
    expect(() => amount('1e4')).toThrow();
    expect(amount('0.0000001')).toBe(1n);
    expect(decode(encode({ n: amount('123456789123.1234567') }))).toEqual({
      n: 1234567891231234567n,
    });
  });
});
describe('funding, consent and schedule', () => {
  it('rejects changed consent and does not duplicate allocation on retry', () => {
    let w = funded();
    expect(() =>
      execute(w, 'dl-open', 'ATTACKER', { type: 'register', terms: 'altered', validUntil: 999999 }),
    ).toThrow();
    const snapshot = encode(w);
    w = execute(w, 'dl-open', p, { type: 'register', terms: round(w).terms, validUntil: 999999 });
    expect(encode(w)).toBe(snapshot);
  });
  it('allows withdrawal before registration closes and releases capital', () => {
    let w = funded();
    w = execute(w, 'dl-open', p, { type: 'leave' });
    expect(round(w).registrations.find((r) => r.wallet === p)?.withdrawn).toBe(true);
    expect(round(w).budgets.capital).toBe(amount(200));
  });
  it('cancels underfunded rounds and refunds the original depositor once', () => {
    let w = newWorld(1000);
    const c = template(1000, { maxPlayers: 2, creator: sponsor });
    w.rounds.push(newRound(c));
    w = execute(w, c.id, sponsor, { type: 'contribute', bucket: 'capital', amount: amount(50) });
    w.now = c.calendar.fundingClose;
    w = execute(w, c.id, op, { type: 'advance' });
    expect(round(w).phase).toBe('cancelled');
    w = execute(w, c.id, 'ANYONE', { type: 'refund', contributionId: 'c1' });
    expect(round(w).budgets.capital).toBe(0n);
    expect(w.events.at(-1)?.detail).toBe(sponsor);
    expect(() => execute(w, c.id, op, { type: 'refund', contributionId: 'c1' })).toThrow();
  });
  it('cancels without spending refund resources when participation is insufficient', () => {
    let w = funded();
    w = execute(w, 'dl-open', p, { type: 'leave' });
    w.now = round(w).config.calendar.fundingClose;
    w = execute(w, 'dl-open', op, { type: 'advance' });
    w.now = round(w).config.calendar.registrationClose;
    w = execute(w, 'dl-open', op, { type: 'advance' });
    expect(round(w).phase).toBe('cancelled');
    for (const c of round(w).contributions)
      w = execute(w, 'dl-open', op, { type: 'refund', contributionId: c.id });
    expect(Object.values(round(w).budgets).every((x) => x === 0n)).toBe(true);
  });
  it('enforces the end timestamp even before the phase transition', () => {
    const w = active();
    w.now = round(w).config.calendar.end;
    expect(() =>
      execute(w, 'dl-open', p, {
        type: 'swap',
        sell: 'USDC',
        buy: 'XLM',
        amount: amount(1),
        minOut: 1n,
        protocol: 'Aquarius',
      }),
    ).toThrow('window');
  });
  it('rejects late capital contributions and enforces private funding', () => {
    let w = active();
    expect(() =>
      execute(w, 'dl-open', sponsor, { type: 'contribute', bucket: 'capital', amount: 1n }),
    ).toThrow();
    w = newWorld(1000);
    const c = template(1000, { fundingMode: 'closed', creator: sponsor });
    w.rounds.push(newRound(c));
    expect(() =>
      execute(w, c.id, p, { type: 'contribute', bucket: 'capital', amount: amount(1) }),
    ).toThrow('authorized');
  });
});
describe('limit orders and executors', () => {
  it('reserves balance, counts escrow in rankings and prevents double spending', () => {
    let w = active();
    w = execute(w, 'dl-open', p, {
      type: 'limit',
      sell: 'USDC',
      buy: 'XLM',
      amount: amount(70),
      minimum: amount(1000),
      expires: round(w).config.calendar.riskCutoff,
    });
    expect(portfolioValue(w, round(w).players[0], round(w).orders)).toBe(amount(100));
    expect(() =>
      execute(w, 'dl-open', p, {
        type: 'swap',
        sell: 'USDC',
        buy: 'XLM',
        amount: amount(40),
        minOut: 1n,
        protocol: 'Aquarius',
      }),
    ).toThrow('balance');
  });
  it('failed fills neither mutate state nor earn rewards; successful fills execute once', () => {
    let w = active();
    const min = quote(w, 'USDC', 'XLM', amount(10), 'Aquarius');
    w = execute(w, 'dl-open', p, {
      type: 'limit',
      sell: 'USDC',
      buy: 'XLM',
      amount: amount(10),
      minimum: min,
      expires: round(w).config.calendar.riskCutoff,
    });
    const id = round(w).orders[0].id,
      snapshot = encode(w);
    expect(() =>
      execute(w, 'dl-open', op, { type: 'fill', orderId: id, protocol: 'Sushi' }),
    ).toThrow('price');
    expect(encode(w)).toBe(snapshot);
    w = execute(w, 'dl-open', op, { type: 'fill', orderId: id, protocol: 'Aquarius' });
    expect(round(w).orders[0].state).toBe('filled');
    expect(() =>
      execute(w, 'dl-open', op, { type: 'fill', orderId: id, protocol: 'Aquarius' }),
    ).toThrow();
  });
  it('releases unfilled orders at settlement without player permission', () => {
    let w = active();
    w = execute(w, 'dl-open', p, {
      type: 'limit',
      sell: 'USDC',
      buy: 'XLM',
      amount: amount(100),
      minimum: amount(900),
      expires: round(w).config.calendar.riskCutoff,
    });
    w = end(w);
    expect(round(w).orders[0].state).toBe('expired');
    expect(round(w).players[0].recovery).toBe(amount(100));
    expect(round(w).phase).toBe('settled');
  });
  it('the executor stops earning when no progress remains', () => {
    const w = end(active());
    expect(drain(w).progressed).toBe(0);
    expect(encode(drain(w).state)).toBe(encode(w));
  });
});
describe('positions and final buyout', () => {
  for (const kind of ['lp', 'blend', 'perp'] as const)
    it(`settles ${kind} with blocked withdrawal, exclusive coverage and explicit residual`, () => {
      let w = active();
      w = execute(w, 'dl-open', p, {
        type: 'position',
        kind,
        asset: kind === 'blend' ? 'USDC' : 'XLM',
        amount: amount(40),
        side: 'long',
        leverage: 2,
      });
      round(w).players[0].positions[0].nativeBlocked = true;
      const before = round(w).budgets.exit;
      w = end(w);
      expect(round(w).phase).toBe('settled');
      expect(round(w).residuals.length).toBe(1);
      expect(round(w).residuals[0].owner).toBe('exit-facility');
      expect(before - round(w).budgets.exit).toBe(round(w).residuals[0].cashPaid);
    });
  it('processes sponsor entitlements without overpaying or redirecting claims', () => {
    let w = end(active());
    for (const c of round(w).contributions)
      w = execute(w, 'dl-open', 'ANYONE', { type: 'sponsor-claim', contributionId: c.id });
    expect(round(w).sponsorPool).toBe(0n);
    expect(Object.values(round(w).budgets).every((x) => x === 0n)).toBe(true);
    w = execute(w, 'dl-open', 'ANYONE', { type: 'claim', beneficiary: p });
    expect(w.events.at(-1)?.detail.startsWith(p)).toBe(true);
    expect(() => execute(w, 'dl-open', 'ANYONE', { type: 'claim', beneficiary: p })).toThrow();
  });
  it("isolates portfolios and never nets other players' losses against profit", () => {
    let w = active();
    w = execute(w, 'dl-open', p, {
      type: 'position',
      kind: 'perp',
      asset: 'XLM',
      amount: amount(50),
      side: 'long',
      leverage: 2,
    });
    w = execute(w, 'dl-open', q, {
      type: 'position',
      kind: 'perp',
      asset: 'XLM',
      amount: amount(50),
      side: 'short',
      leverage: 2,
    });
    w.prices.XLM = (w.prices.XLM * 110n) / 100n;
    w = end(w);
    const a = round(w).players[0],
      b = round(w).players[1];
    expect(a.playerPayout).toBe(amount(10));
    expect(b.playerPayout).toBe(0n);
    expect(round(w).sponsorPool).toBe(amount(190));
  });
});
describe('settlement consistency', () => {
  it('uses a shared snapshot when prices change between settlements', () => {
    let w = active();
    w = execute(w, 'dl-open', p, {
      type: 'swap',
      sell: 'USDC',
      buy: 'XLM',
      amount: amount(10),
      minOut: 1n,
      protocol: 'Aquarius',
    });
    w.now = round(w).config.calendar.end;
    w = execute(w, 'dl-open', op, { type: 'advance' });
    const expected = portfolioValue(w, round(w).players[0]);
    w.prices.XLM *= 10n;
    w = execute(w, 'dl-open', op, { type: 'settle-player', wallet: p });
    expect(round(w).players[0].recovery).toBe(expected);
  });
  it('does not buy cash already recovered when the cap is reached', () => {
    let w = active();
    w = execute(w, 'dl-open', p, {
      type: 'position',
      kind: 'perp',
      asset: 'XLM',
      amount: amount(50),
      side: 'long',
      leverage: 5,
    });
    round(w).players[0].positions[0].nativeBlocked = true;
    w.prices.XLM *= 4n;
    const before = round(w).budgets.exit;
    w = end(w);
    expect(round(w).players[0].recovery).toBe(amount(200));
    expect(before - round(w).budgets.exit).toBe(amount(150));
    expect(round(w).residuals[0].cashPaid).toBe(amount(150));
  });
});
