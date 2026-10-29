export const SCALE = 10_000_000n;
export function amount(value: string | number): bigint {
  const input = String(value);
  if (!/^\d+(\.\d{1,7})?$/.test(input))
    throw new Error('Invalid amount: use up to seven decimals, without exponents.');
  const [whole, fraction = ''] = input.split('.');
  const n = BigInt(whole) * SCALE + BigInt(fraction.padEnd(7, '0'));
  if (n > 2n ** 120n) throw new Error('Amount is out of range.');
  return n;
}
export function format(n: bigint, digits = 2): string {
  const sign = n < 0n ? '-' : '';
  const a = n < 0n ? -n : n;
  const whole = (a / SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (a % SCALE).toString().padStart(7, '0').slice(0, digits);
  return sign + whole + (digits ? '.' + fraction : '');
}
export const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const max = (a: bigint, b: bigint) => (a > b ? a : b);
export function distribute(recovery: bigint, capital: bigint, shareBps: number) {
  if (
    recovery < 0n ||
    capital < 0n ||
    !Number.isInteger(shareBps) ||
    shareBps < 0 ||
    shareBps > 10000
  )
    throw new Error('Invalid economics.');
  const gain = max(recovery - capital, 0n);
  const player = (gain * BigInt(shareBps)) / 10_000n;
  return { player, sponsor: recovery - player };
}
export const encode = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? { $amount: v.toString() } : v));
export const decode = <T>(value: string): T =>
  JSON.parse(value, (_, v) =>
    v &&
    typeof v === 'object' &&
    Object.keys(v).length === 1 &&
    typeof v.$amount === 'string' &&
    /^-?\d+$/.test(v.$amount)
      ? BigInt(v.$amount)
      : v,
  );
