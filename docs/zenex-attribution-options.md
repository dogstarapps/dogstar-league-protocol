# Zenex settlement attribution

The user selected option A below. A real venue accounting extension is required before admitting Zenex to prize-bearing rounds. The generic cash purchase mechanism is implemented; a Zenex adapter is not yet admitted. No attestation system described here is implemented.

## Concrete integration constraint

A Zenex keeper can liquidate or auto-deleverage a position without calling our vault first. A successful trader payment goes directly to the user's settlement-token balance; a failed payment becomes claimable credit. Earned funding also enters credit. A contract address can receive unsolicited transfers of the same token. Consequently, measuring its current token balance cannot distinguish an external trading payout from a donation. Counting only cash received during our own exit would omit legitimate earlier forced payouts.

The [fee and settlement documentation](https://docs.zenex.trade/technical/market/fee-system) describes direct and parked payments. The [funding/credit interface](https://docs.zenex.trade/technical/market/funding-rate) exposes current unpaid credit, not a cumulative counter of already successful trader payments. The [event documentation](https://docs.zenex.trade/technical/market/events) records fills and credit claims off chain. Events are useful evidence for an indexer; a Soroban contract cannot simply read historical transaction events as authenticated state.

The deployed ABI inspected in this project has no per-user cumulative successful settlement getter. This is an integration finding for the inspected code hash, not a claim about every future Zenex release.

## Option A: authenticated accounting in the venue

The preferred trust model is a venue-provided cumulative cash-flow or settlement-receipt interface. It must account for fills, forced closes, refunds, funding credits and claims without double counting, and bind each value to its user and position lifecycle. The vault can then compare authoritative state before and after its lifecycle and exclude unsolicited transfers. A receipt/callback design must also handle failed token delivery and frozen state.

This requires agreement and implementation by Zenex for its own market; Dogstar cannot add a getter to somebody else's deployed contract. Deploying a modified market with separate liquidity is a different product and must not be presented as integrating the existing market.

## Option B: explicit event certification for ranking

A launch alternative separates cash custody from certified competition scoring. Independent indexers reconstruct each isolated vault's actual protocol flows from finalized transactions. A round names an immutable threshold and distinct signing operators. They certify the market/code hash, vault, lifecycle identifiers, ledger interval, cumulative protocol cash flows and evidence digest. Nonces and previous commitments prevent replay or overlapping claims.

The round still closes financially using native exits or its prefunded purchase. Certification must never acquire custody authority, change beneficiaries or block contractual cash closure. If a complete final ranking is not certified by a published deadline, prize contributions are refunded rather than awarded from an unverified balance. Player/sponsor cash claims and prize claims need separate state transitions for this model.

This introduces explicit trust in the signing threshold for prize allocation and shared performance figures. Multiple indexers do not automatically make that trust permissionless or Sybil resistant. Dogstar must not describe its own single backend as decentralized verification. Evidence should be public and independently reproducible; operator identities, threshold, failure rules and any compensation must be published before funding. A signed price report alone does not prove the recipient's historical cash flows.

## Decision boundary

Option A retains fully on-chain protocol attribution but depends on an external integration change. Option B can support the existing market but changes the round's trust and prize-settlement model and requires explicit product agreement, implementation and review. Neither option is resolved by silently treating donated token balances as trading profit, imposing an arbitrary profit ceiling or ignoring forced exits. A complete Stellar light client for event inclusion would be a separate security-critical project, not a small adapter feature.

The independent emergency purchase remains useful under either model. It transfers local ownership of the isolated vault and pays a known cash strike; it cannot promise unlimited unknown profit or unfreeze the external market.


## Selected direction (2026-10-29)

The user selected option A: settlement attribution verifiable in the contract, rather than a threshold of external ranking certifiers. A wallet balance alone cannot distinguish a forced venue payout from a donation. The required venue integration must expose authenticated cumulative per-vault cash settlement, or an equivalent enforceable callback/accounting interface covering liquidation, ADL, cancellation and ordinary settlement. It must handle payouts outside a Dogstar executor transaction.

No adapter may advertise verified Zenex ranking until that real deployed interface is available and tested against the pinned market code. Fixture implementations can validate our accounting rules but do not establish that the current market supports them. Permissionless prefunded cash purchase and local residual ownership remain independent of this ranking dependency.


An experimental adapter/vault and seven accounting/authorization tests now implement the selected interface. The inspected deployed market remains incompatible and unadmitted. See [the concrete adapter and venue requirements](zenex-adapter.md) and [current ABI inspection evidence](evidence/zenex-interface-inspection-2026-10-30.json).
