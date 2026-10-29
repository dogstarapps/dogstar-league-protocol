import { SCALE, min, max, encode, distribute } from './money.js';
import { ASSETS } from './catalog.js';
import type {
  Amount,
  Bucket,
  Command,
  Config,
  LimitOrder,
  Player,
  Position,
  Protocol,
  Round,
  Symbol,
  World,
} from './types.js';
export function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function validateConfig(c: Config) {
  const d = c.calendar;
  if (c.organizerWebsite) {
    let valid = false;
    try {
      const url = new URL(c.organizerWebsite);
      valid = url.protocol === 'https:' && !url.username && !url.password;
    } catch {}
    assert(valid, 'Organizer website must be an HTTPS URL without credentials.');
  }
  assert(
    !c.organizerBio || c.organizerBio.length <= 280,
    'Organizer bio must be 280 characters or fewer.',
  );
  assert(
    c.id.length > 0 && c.title.trim().length >= 4 && c.creator.length > 0,
    'Identity and title are required.',
  );
  assert(
    [
      d.fundingOpen,
      d.fundingClose,
      d.registrationOpen,
      d.registrationClose,
      d.preparationDeadline,
      d.start,
      d.riskCutoff,
      d.end,
      d.settlementDeadline,
    ].every(Number.isSafeInteger),
    'Invalid UTC timestamps.',
  );
  assert(
    d.fundingOpen < d.fundingClose &&
      d.registrationOpen < d.registrationClose &&
      d.fundingClose <= d.registrationClose &&
      d.registrationClose <= d.preparationDeadline &&
      d.preparationDeadline < d.start &&
      d.start < d.riskCutoff &&
      d.riskCutoff <= d.end &&
      d.end < d.settlementDeadline,
    'The schedule must follow funding, registration, preparation, trading and settlement order.',
  );
  assert(
    Number.isInteger(c.minPlayers) &&
      Number.isInteger(c.maxPlayers) &&
      c.minPlayers >= 1 &&
      c.maxPlayers >= c.minPlayers &&
      c.maxPlayers <= 10000,
    'Invalid player capacity.',
  );
  assert(
    c.capitalPerPlayer > 0n && c.payoffCap >= c.capitalPerPlayer && c.prizeTarget >= 0n,
    'Invalid capital or recovery cap.',
  );
  assert(
    Number.isInteger(c.playerShareBps) && c.playerShareBps >= 0 && c.playerShareBps <= 10000,
    'Profit share must be between 0 and 100%.',
  );
  assert(
    c.executionTarget >= c.executorReward * BigInt(3 + c.maxPlayers * 2) && c.executorReward >= 0n,
    'Execution funding does not cover mandatory tasks.',
  );
  assert(
    c.assets.includes('USDC') &&
      c.assets.length >= 2 &&
      new Set(c.assets).size === c.assets.length &&
      c.assets.every((a) => ASSETS.some((x) => x.symbol === a)),
    'Invalid asset catalog.',
  );
  assert(
    c.protocols.length > 0 &&
      new Set(c.protocols).size === c.protocols.length &&
      c.protocols.every((p) => ['Aquarius', 'Sushi', 'Soroswap', 'Blend', 'Zenex'].includes(p)),
    'Invalid protocols.',
  );
  assert(!c.mylab, 'MyLab emissions are outside the core protocol.');
}
export function requirements(c: Config): Record<Bucket, Amount> {
  return {
    capital: c.capitalPerPlayer * BigInt(c.maxPlayers),
    prizes: c.prizeTarget,
    execution: c.executionTarget,
    exit: c.payoffCap * BigInt(c.maxPlayers),
  };
}
export function newRound(c: Config): Round {
  validateConfig(c);
  const config = structuredClone(c);
  return {
    config,
    terms: encode(config),
    phase: 'funding',
    budgets: { capital: 0n, prizes: 0n, execution: 0n, exit: 0n },
    contributions: [],
    registrations: [],
    players: [],
    orders: [],
    residuals: [],
    executorEarnings: {},
    feeReserved: 0n,
    sponsorPool: 0n,
    settledCapital: 0n,
    nonce: 0,
    fundingSealed: false,
  };
}
export function newWorld(now: number): World {
  return {
    schema: 1,
    now,
    rounds: [],
    events: [],
    prices: Object.fromEntries(ASSETS.map((a) => [a.symbol, a.demoPrice])) as World['prices'],
  };
}
export function addRound(world: World, config: Config): World {
  assert(!world.rounds.some((r) => r.config.id === config.id), 'This round already exists.');
  assert(config.calendar.fundingClose > world.now, 'Funding must close in the future.');
  const next = structuredClone(world);
  next.rounds.push(newRound(config));
  return next;
}
export function quote(
  world: World,
  sell: Symbol,
  buy: Symbol,
  n: Amount,
  protocol: Protocol,
): Amount {
  assert(n > 0n && sell !== buy, 'Invalid amount or pair.');
  assert(['Aquarius', 'Sushi', 'Soroswap'].includes(protocol), 'This is not a Spot venue.');
  const fee = protocol === 'Aquarius' ? 10n : protocol === 'Sushi' ? 30n : 25n;
  return (n * world.prices[sell] * (10000n - fee)) / world.prices[buy] / 10000n;
}
export function positionValue(w: World, p: Position): Amount {
  if (p.kind === 'blend')
    return (
      p.principal +
      (p.principal * BigInt(Math.max(0, w.now - p.openedAt)) * 500n) / (10000n * 31536000n)
    ); // Illustrative 5% APR, not a live quote.
  if (p.kind === 'lp') {
    const current = (p.units * w.prices[p.asset]) / SCALE;
    return max(0n, (current + p.principal) / 2n);
  }
  const delta = (w.prices[p.asset] - (p.entryPrice ?? 1n)) * (p.side === 'short' ? -1n : 1n);
  return max(
    0n,
    p.principal + (p.principal * delta * BigInt(p.leverage ?? 1)) / (p.entryPrice ?? 1n),
  );
}
export function portfolioValue(w: World, p: Player, orders: LimitOrder[] = []): Amount {
  return (
    Object.entries(p.balances).reduce(
      (s, [a, n]) => s + ((n ?? 0n) * w.prices[a as Symbol]) / SCALE,
      0n,
    ) +
    p.positions.reduce((s, x) => s + positionValue(w, x), 0n) +
    orders
      .filter((o) => o.wallet === p.wallet && o.state === 'open')
      .reduce((s, o) => s + (o.amount * w.prices[o.sell]) / SCALE, 0n)
  );
}
function credit(p: Player, a: Symbol, n: Amount) {
  p.balances[a] = (p.balances[a] ?? 0n) + n;
}
function debit(p: Player, a: Symbol, n: Amount) {
  assert(n > 0n && (p.balances[a] ?? 0n) >= n, 'Insufficient available balance.');
  credit(p, a, -n);
}
function event(w: World, r: Round, actor: string, kind: string, detail: string) {
  w.events.push({ id: w.events.length + 1, at: w.now, roundId: r.config.id, actor, kind, detail });
}
function reward(r: Round, actor: string) {
  const n = r.config.executorReward;
  assert(r.budgets.execution - r.feeReserved >= n, 'Insufficient execution budget.');
  r.budgets.execution -= n;
  r.executorEarnings[actor] = (r.executorEarnings[actor] ?? 0n) + n;
}
function trading(w: World, r: Round, increase = true) {
  assert(
    r.phase === 'active' &&
      w.now >= r.config.calendar.start &&
      w.now < (increase ? r.config.calendar.riskCutoff : r.config.calendar.end),
    'The window for this operation is closed.',
  );
}
function releaseOrder(r: Round, o: Round['orders'][number], state: 'cancelled' | 'expired') {
  const p = r.players.find((p) => p.wallet === o.wallet)!;
  credit(p, o.sell, o.amount);
  r.feeReserved -= o.reward;
  o.state = state;
}
function readyFunding(r: Round) {
  const req = requirements(r.config);
  return (Object.keys(req) as Bucket[]).every((b) => r.budgets[b] >= req[b]);
}
function confirm(r: Round, now: number) {
  for (const reg of r.registrations) {
    if (
      reg.confirmed ||
      reg.withdrawn ||
      reg.validUntil < now ||
      reg.terms !== r.terms ||
      r.players.length >= r.config.maxPlayers
    )
      continue;
    reg.confirmed = true;
    r.players.push({
      wallet: reg.wallet,
      nickname: reg.wallet.startsWith('DEMO_')
        ? reg.wallet.replace('DEMO_', '')
        : 'Player ' + (r.players.length + 1),
      balances: { USDC: r.config.capitalPerPlayer },
      positions: [],
      prepared: false,
      playerPayout: 0n,
      sponsorReturn: 0n,
      prize: 0n,
      claimed: false,
      settled: false,
    });
    r.budgets.capital -= r.config.capitalPerPlayer;
  }
}
export function execute(world: World, id: string, actor: string, command: Command): World {
  assert(actor.trim().length > 0, 'Connect a demo identity or your wallet.');
  const w = structuredClone(world),
    r = w.rounds.find((r) => r.config.id === id);
  assert(r, 'Round not found.');
  const c = r.config,
    d = c.calendar,
    now = w.now;
  const player = () => {
    const p = r.players.find((p) => p.wallet === actor);
    assert(p, 'You do not have a confirmed seat.');
    return p;
  };
  switch (command.type) {
    case 'contribute': {
      assert(
        r.phase !== 'cancelled' && r.phase !== 'settled' && r.phase !== 'settling',
        'This round is not accepting contributions.',
      );
      assert(command.amount > 0n, 'Amount must be positive.');
      assert(
        c.fundingMode === 'public' ||
          actor === c.creator ||
          (c.fundingMode === 'private' && c.sponsorAllowlist.includes(actor)),
        'Wallet is not authorized to fund this round.',
      );
      const late = command.bucket === 'prizes' && c.extraPrizes && now < d.end;
      assert(
        now >= d.fundingOpen && ((now < d.fundingClose && !r.fundingSealed) || late),
        'The funding window is closed.',
      );
      const req = requirements(c);
      const total = r.contributions
        .filter((x) => x.bucket === command.bucket)
        .reduce((s, x) => s + x.amount, 0n);
      assert(
        late || total + command.amount <= req[command.bucket],
        "Contribution exceeds this budget's maximum.",
      );
      r.budgets[command.bucket] += command.amount;
      r.contributions.push({
        id: `c${++r.nonce}`,
        owner: actor,
        bucket: command.bucket,
        amount: command.amount,
        claimed: false,
      });
      event(w, r, actor, 'funding', command.bucket);
      break;
    }
    case 'register': {
      assert(
        ['funding', 'registration'].includes(r.phase) &&
          now >= d.registrationOpen &&
          now < d.registrationClose,
        'Registration is closed.',
      );
      assert(
        command.terms === r.terms && command.validUntil >= d.registrationClose,
        'Accept the published rules through registration close.',
      );
      assert(
        !c.playerAllowlist.length || c.playerAllowlist.includes(actor),
        'This round requires an invitation.',
      );
      const existing = r.registrations.find((x) => x.wallet === actor && !x.withdrawn);
      if (existing) return world;
      assert(
        r.registrations.filter((x) => !x.withdrawn).length < c.maxPlayers,
        'No registration seats remain.',
      );
      r.registrations.push({
        wallet: actor,
        terms: command.terms,
        validUntil: command.validUntil,
        confirmed: false,
        withdrawn: false,
      });
      if (r.fundingSealed) confirm(r, now);
      const p = r.players.find((p) => p.wallet === actor);
      if (p && command.nickname) p.nickname = command.nickname.slice(0, 30);
      event(
        w,
        r,
        actor,
        'registration',
        r.fundingSealed ? 'Seat confirmed' : 'Registration consent recorded',
      );
      break;
    }
    case 'leave': {
      assert(
        now < d.registrationClose && ['funding', 'registration'].includes(r.phase),
        'The registration withdrawal window is closed.',
      );
      const reg = r.registrations.find((x) => x.wallet === actor && !x.withdrawn);
      assert(reg, 'Registration not found.');
      reg.withdrawn = true;
      if (reg.confirmed) {
        r.players = r.players.filter((p) => p.wallet !== actor);
        r.budgets.capital += c.capitalPerPlayer;
        reg.confirmed = false;
      }
      event(w, r, actor, 'leave', 'Resources released');
      break;
    }
    case 'advance': {
      let progress = false;
      if (r.phase === 'funding' && now >= d.fundingClose) {
        if (!readyFunding(r)) {
          r.phase = 'cancelled';
          event(w, r, actor, 'cancel', 'Insufficient funding');
          return w;
        }
        r.fundingSealed = true;
        r.phase = 'registration';
        confirm(r, now);
        progress = true;
      }
      if (r.phase === 'registration' && now >= d.registrationClose) {
        if (r.players.length < c.minPlayers || now > d.preparationDeadline) {
          r.phase = 'cancelled';
          event(
            w,
            r,
            actor,
            'cancel',
            'Minimum participation or preparation requirements were not met',
          );
          return w;
        }
        r.phase = 'ready';
        r.players.forEach((p) => (p.prepared = true));
        progress = true;
      }
      if (r.phase === 'ready' && now >= d.start) {
        assert(
          r.players.every((p) => p.prepared),
          'Preparation is pending.',
        );
        r.phase = 'active';
        progress = true;
      }
      if (r.phase === 'active' && now >= d.end) {
        r.orders.filter((o) => o.state === 'open').forEach((o) => releaseOrder(r, o, 'expired'));
        r.snapshot = { prices: structuredClone(w.prices), at: d.end };
        r.phase = 'settling';
        progress = true;
      }
      assert(progress, 'No transition is pending.');
      if (r.phase === 'active' || r.phase === 'settling') reward(r, actor);
      event(w, r, actor, 'advance', r.phase);
      break;
    }
    case 'swap': {
      trading(w, r);
      assert(
        c.protocols.includes(command.protocol) &&
          c.assets.includes(command.sell) &&
          c.assets.includes(command.buy),
        'Instrument is not admitted.',
      );
      const out = quote(w, command.sell, command.buy, command.amount, command.protocol);
      assert(
        out >= command.minOut && command.minOut > 0n,
        'The net price does not meet the minimum.',
      );
      const p = player();
      debit(p, command.sell, command.amount);
      credit(p, command.buy, out);
      event(w, r, actor, 'swap', `${command.sell} → ${command.buy} · ${command.protocol}`);
      break;
    }
    case 'limit': {
      trading(w, r);
      assert(
        c.assets.includes(command.sell) &&
          c.assets.includes(command.buy) &&
          command.sell !== command.buy,
        'Pair is not admitted.',
      );
      assert(
        command.expires > now && command.expires <= d.riskCutoff && command.minimum > 0n,
        'Invalid expiry or minimum.',
      );
      const mandatory = c.executorReward * BigInt(2 + r.players.filter((p) => !p.settled).length);
      assert(
        r.budgets.execution - r.feeReserved >= mandatory + c.executorReward,
        'No free budget is available for this order.',
      );
      debit(player(), command.sell, command.amount);
      r.feeReserved += c.executorReward;
      r.orders.push({
        id: `o${++r.nonce}`,
        wallet: actor,
        sell: command.sell,
        buy: command.buy,
        amount: command.amount,
        minimum: command.minimum,
        expires: command.expires,
        reward: c.executorReward,
        state: 'open',
        nonce: r.nonce,
      });
      event(w, r, actor, 'limit', 'Funds and reward reserved');
      break;
    }
    case 'cancel': {
      const order = r.orders.find((o) => o.id === command.orderId);
      assert(
        order && order.wallet === actor && order.state === 'open',
        'You cannot cancel this order.',
      );
      releaseOrder(r, order, 'cancelled');
      event(w, r, actor, 'cancel-order', order.id);
      break;
    }
    case 'fill': {
      trading(w, r);
      const o = r.orders.find((o) => o.id === command.orderId);
      assert(o && o.state === 'open' && now < o.expires, 'Order already consumed or expired.');
      assert(c.protocols.includes(command.protocol), 'Venue is not admitted.');
      const out = quote(w, o.sell, o.buy, o.amount, command.protocol);
      assert(out >= o.minimum, 'The net price does not meet the order.');
      const p = r.players.find((p) => p.wallet === o.wallet)!;
      credit(p, o.buy, out);
      o.state = 'filled';
      r.feeReserved -= o.reward;
      reward(r, actor);
      event(w, r, actor, 'fill', o.id);
      break;
    }
    case 'position': {
      trading(w, r);
      const p = player(),
        x = command;
      assert(c.assets.includes(x.asset), 'Asset is not admitted.');
      const protocol =
        x.kind === 'blend'
          ? 'Blend'
          : x.kind === 'perp'
            ? 'Zenex'
            : c.protocols.includes('Aquarius')
              ? 'Aquarius'
              : 'Soroswap';
      assert(c.protocols.includes(protocol), 'Protocol is not admitted.');
      assert(
        x.kind !== 'blend' || x.asset === 'USDC',
        'The Blend simulation only models the USDC reserve.',
      );
      assert(
        x.kind !== 'perp' ||
          (x.asset === 'XLM' &&
            (x.side === 'long' || x.side === 'short') &&
            Number.isInteger(x.leverage) &&
            x.leverage! >= 1 &&
            x.leverage! <= 5),
        'The derivatives simulation requires XLM, a defined side and 1–5x leverage.',
      );
      assert(
        p.positions.filter((p) => p.kind === x.kind).length < 4,
        'Position limit reached for this profile.',
      );
      debit(p, 'USDC', x.amount);
      p.positions.push({
        id: `p${++r.nonce}`,
        kind: x.kind,
        asset: x.asset,
        protocol,
        principal: x.amount,
        units: (x.amount * SCALE) / w.prices[x.asset],
        openedAt: now,
        side: x.side,
        leverage: x.leverage,
        entryPrice: w.prices[x.asset],
        nativeBlocked: false,
      });
      event(w, r, actor, 'position', `${protocol} · ${x.kind}`);
      break;
    }
    case 'close-position': {
      trading(w, r, false);
      const p = player(),
        pos = p.positions.find((x) => x.id === command.positionId);
      assert(
        pos && !pos.nativeBlocked,
        'Native withdrawal is unavailable; the final exit policy remains funded.',
      );
      credit(p, 'USDC', positionValue(w, pos));
      p.positions = p.positions.filter((x) => x.id !== pos.id);
      event(w, r, actor, 'close-position', pos.id);
      break;
    }
    case 'settle-player': {
      assert(r.phase === 'settling' && now >= d.end, 'The round is not settling.');
      const p = r.players.find((p) => p.wallet === command.wallet);
      assert(p && !p.settled, 'Portfolio not found or already settled.');
      const terminal = {
        ...w,
        now: r.snapshot?.at ?? d.end,
        prices: r.snapshot?.prices ?? w.prices,
      };
      const gross = portfolioValue(terminal, p),
        recovery = min(gross, c.payoffCap);
      const blocked = p.positions
        .filter((x) => x.nativeBlocked)
        .reduce((sum, pos) => sum + positionValue(terminal, pos), 0n);
      const nativeValue = gross - blocked;
      const cashNeeded = max(recovery - nativeValue, 0n),
        cashSurplus = max(nativeValue - recovery, 0n);
      assert(r.budgets.exit >= cashNeeded, 'Insufficient coverage.');
      r.budgets.exit += cashSurplus - cashNeeded;
      let left = cashNeeded;
      for (const pos of p.positions.filter((x) => x.nativeBlocked)) {
        const paid = min(positionValue(terminal, pos), left);
        r.residuals.push({
          position: structuredClone(pos),
          formerPlayer: p.wallet,
          owner: 'exit-facility',
          cashPaid: paid,
        });
        left -= paid;
      }
      const split = distribute(recovery, c.capitalPerPlayer, c.playerShareBps);
      p.recovery = recovery;
      p.playerPayout = split.player;
      p.sponsorReturn = split.sponsor;
      p.settled = true;
      p.balances = {};
      p.positions = [];
      r.sponsorPool += split.sponsor;
      r.settledCapital += recovery;
      reward(r, actor);
      event(
        w,
        r,
        actor,
        'settle-player',
        blocked > 0n
          ? 'Final buyout: provider retains the residual'
          : 'Simulated native withdrawal',
      );
      break;
    }
    case 'finalize': {
      assert(
        r.phase === 'settling' && r.players.every((p) => p.settled),
        'Some portfolios still need settlement.',
      );
      const ranked = [...r.players].sort((a, b) =>
        (a.recovery ?? 0n) === (b.recovery ?? 0n)
          ? r.players.indexOf(a) - r.players.indexOf(b)
          : (a.recovery ?? 0n) > (b.recovery ?? 0n)
            ? -1
            : 1,
      );
      if (ranked.length) {
        ranked[0].prize = r.budgets.prizes;
        r.budgets.prizes = 0n;
      }
      r.phase = 'settled';
      reward(r, actor);
      event(w, r, actor, 'finalize', 'First-place prize; registration order breaks ties');
      break;
    }
    case 'claim': {
      assert(r.phase === 'settled', 'Claims are not available yet.');
      const p = r.players.find((p) => p.wallet === command.beneficiary);
      assert(p && !p.claimed, 'Claim not found or already consumed.');
      // Any actor can deliver only to the recorded beneficiary; no redirect is accepted.
      p.claimed = true;
      event(w, r, actor, 'claim', `${p.wallet} · ${p.playerPayout + p.prize}`);
      break;
    }
    case 'refund': {
      assert(r.phase === 'cancelled', 'Refunds are not enabled.');
      const x = r.contributions.find((x) => x.id === command.contributionId);
      assert(x && !x.claimed, 'Contribution not found or already claimed.');
      // Capital held by confirmed players returns to original depositors when cancelled.
      if (x.bucket === 'capital' && r.budgets.capital < x.amount) {
        r.players.forEach((p) => (p.balances = {}));
        r.budgets.capital += BigInt(r.players.length) * c.capitalPerPlayer;
        r.players = [];
      }
      assert(r.budgets[x.bucket] >= x.amount, 'Insufficient refund balance.');
      r.budgets[x.bucket] -= x.amount;
      x.claimed = true;
      event(w, r, actor, 'refund', x.owner);
      break;
    }
    case 'sponsor-claim': {
      assert(r.phase === 'settled', 'The round has not settled.');
      const x = r.contributions.find((x) => x.id === command.contributionId);
      assert(x && !x.claimed, 'Entitlement already consumed.');
      // Determine all entitlements against fixed totals, then allocate rounding remainder to last contribution.
      const group = r.contributions.filter((a) => a.bucket === x.bucket);
      const total = group.reduce((s, a) => s + a.amount, 0n);
      let pool = x.bucket === 'capital' ? r.sponsorPool + r.budgets.capital : r.budgets[x.bucket];
      const pending = group.filter((a) => !a.claimed);
      const pendingWeight = pending.reduce((s, a) => s + a.amount, 0n);
      const payout = pending.length === 1 ? pool : (pool * x.amount) / pendingWeight;
      assert(total > 0n, 'No entitlement.');
      if (x.bucket === 'capital') {
        const from = min(r.sponsorPool, payout);
        r.sponsorPool -= from;
        r.budgets.capital -= payout - from;
      } else r.budgets[x.bucket] -= payout;
      x.claimed = true;
      event(w, r, actor, 'sponsor-claim', `${x.owner} · ${payout}`);
      break;
    }
  }
  return w;
}
export function plan(w: World, r: Round): Command[] {
  const d = r.config.calendar;
  if (
    (r.phase === 'funding' && w.now >= d.fundingClose) ||
    (r.phase === 'registration' && w.now >= d.registrationClose) ||
    (r.phase === 'ready' && w.now >= d.start) ||
    (r.phase === 'active' && w.now >= d.end)
  )
    return [{ type: 'advance' }];
  if (r.phase === 'settling') {
    const p = r.players.find((p) => !p.settled);
    return p ? [{ type: 'settle-player', wallet: p.wallet }] : [{ type: 'finalize' }];
  }
  if (r.phase === 'active' && w.now < d.riskCutoff)
    return r.orders
      .filter((o) => o.state === 'open' && w.now < o.expires)
      .flatMap((o) => {
        const venue = r.config.protocols
          .filter((p) => ['Aquarius', 'Sushi', 'Soroswap'].includes(p))
          .find((p) => quote(w, o.sell, o.buy, o.amount, p) >= o.minimum);
        return venue ? [{ type: 'fill' as const, orderId: o.id, protocol: venue }] : [];
      });
  return [];
}
