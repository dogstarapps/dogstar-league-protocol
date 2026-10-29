# Exit purchase terms

ABI 0.3.0: implemented for contract-held Spot balances; generic protocol position vaults remain separate integration work.

Round custody holds sponsored assets under the player's signed immutable rules. The player's wallet authorizes choices; it does not hold the sponsored assets outside contract control. A public operator can therefore close or settle without obtaining a new player signature.

Each covered round deploys its own approved immutable facility and Spot receipt implementation. Its terms identify the cash provider, recovery basis points, premium basis points, minimum capacity, risk cutoff, purchase deadline and exact code hashes. The provider signs those round terms when funding. Only that explicitly committed cash becomes capacity; unsolicited token transfers cannot create a provider commitment. Uncommitted surplus is separate from reserved obligations. Before confirming participants the facility must meet its capacity commitment. Unallocated cash stays locked until risk cutoff or cancellation, and reserved obligations cannot be withdrawn.

A Spot receipt records player, token units and cash cost basis. Cash purchases add their actual input basis; token sales remove proportional basis; token-to-token conversions carry that basis. Unsigned transfers directly to the round do not credit a player's portfolio. Coverage and a disclosed premium are part of the atomic swap: insufficient aggregate capacity reverts token transfers and accounting. Limit orders reserve their premium and restore it on cancellation. Cash reductions remain available after risk cutoff until trading ends.

Native closure credits actual cash recovered, with no emergency-strike ceiling on those gains. After the deadline an operator can instead purchase a receipt using its reserved strike. The facility changes local ownership and pays the round atomically. This path invokes neither the external swap venue, its oracle nor the residual token. The player receives the contractual cash amount and settlement proceeds; the provider owns the residual token claim and may redeem it to its fixed address later. A failed token redemption does not consume that claim.

A finite reserve cannot promise arbitrary unknown future profit. A high strike provides valuable downside protection and can expose its provider to substantial losses. The provider needs sufficient premiums, risk limits, review and incentives to operate native exits before fallback. Source code does not establish that an economically willing provider exists. Do not silently impose this fixed emergency strike as a universal profit cap or present a fixture as funded production liquidity.

Settlement still ranks recovered cash, not a certified common historical end snapshot. Asynchronous venue liquidations/credits require verifiable attribution before they can safely participate in cash-based competition results. This is particularly relevant to Zenex: permissionless external changes must not allow donations to become competitive profit.

The guarantee assumes the settlement token remains transferable and the chain can execute transactions. Official deployment tooling selects Stellar's native asset. Issuer-frozen external assets can remain illiquid for the provider even after player obligations are paid.
