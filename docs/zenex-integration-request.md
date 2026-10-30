# Zenex integration request for Dogstar League

This is a reviewable technical request, not an integration agreement or a live admission. Dogstar's own isolated-position wrapper is implemented and fixture-tested. The current inspected Zenex market remains incompatible. The user selected venue-owned on-chain attribution; an external indexer/certifier is not a substitute.

## The essential venue change

Expose an authenticated, monotonic **cumulative total of settlement tokens successfully paid by the market to each trader address**. Dogstar uses a distinct immutable contract address for every position, so trader-address accounting isolates each position's lifecycle.

The missing information is historical successful payments, not the current wallet balance or unpaid credit. A liquidator or ADL keeper can pay our vault before our executor calls it. Anyone can also donate the same token to that vault. Wallet balances cannot distinguish those two sources. Existing `get_position` and `get_claimable_credit` views do not recover successful past payments.

A minimal venue API could be `get_cumulative_trader_paid(user: Address) -> i128`, composed with existing position/credit/order views. The function name is negotiable. Our current prototype uses the combined `get_trader_state(user) -> TraderState` ABI in [the adapter specification](zenex-adapter.md), including accounting version/epoch, monotonic sequence, paid total, unpaid credit, both remaining notionals and pending-order count. An equivalent venue-owned interface can be adapted after its semantics are agreed; the exact prototype name is not the fundamental requirement.

The state must belong to the market and be updated atomically with actual token delivery. It cannot be populated by the caller, a display-price server, a Dogstar API or third-party event certificates. Reading it must require no player signature. Its storage must remain persistent/restorable, with no silent reset to zero after a close, migration, archival or credit claim. New isolated vaults only need correct accounting from their own creation baseline onward; we are not asking the venue to reconstruct all historical traders' cash flows.

## Payment semantics to implement and test

| Event/path | Cumulative paid | Unpaid credit / other state |
| --- | --- | --- |
| Successful ordinary or partial close | Increase by actual trader tokens delivered | Update position to the actual remaining size |
| Successful liquidation or ADL by any keeper | Increase by actual trader tokens delivered | Reflect actual remaining/closed size, even outside a Dogstar transaction |
| Trader payout fails and parks as credit | Do not increase | Increase the unpaid entitlement once |
| Full or partial successful `claim_credit` | Increase by the amount actually paid, once | Reduce credit by that same amount |
| Funding earned but not paid | Do not increase | Preserve the actual unpaid funding credit |
| Order cancellation / trader escrow refund | Increase by successfully returned trader tokens | Remove/refund the actual order; no duplicate count |
| An unrelated wallet donates tokens to our vault | Do not change | No protocol payment has occurred |
| Keeper/treasury fee paid to another recipient | Do not change | Count only the trader leg |
| Token transfer or whole transaction reverts | All related writes revert | No paid/credit/order half-update |

Coverage should include every trader-payment path used by the admitted wrapper, including direct refunds that bypass `pay_trader`. An administrator must not be able to forge a paid amount without corresponding delivery. If a code migration changes accounting semantics, it needs a new reviewed admission; our old round's local cash purchase must remain independent.

## Signed price reports and execution access

We need a supported way for each independent executor to obtain the **complete signed Chainlink Data Streams `fullReport`** for the market's exact feed. Provide the report schema/precision, verifier/oracle identity, current fill/protective staleness settings, expected request latency, access/pricing/quotas and the supported credential or relay arrangement. Public decoded ticker values cannot be submitted in place of the signed report. Credentials stay server-side and independent operators must be able to operate without a private Dogstar-only endpoint.

The observed XLM-USD feed is `000358cb12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a`. The official deployment documentation describes a fifteen-second fill window at its dated observation. Current on-chain settings and exact reports must be rechecked during admission; a preview simulation can pass and the later transaction can still expire. Our executor already accepts bounded full reports and retries native closure. It bypasses reports/venue calls after the prefunded purchase deadline.

Confirm support for a contract trader using exact nested authorization, with market increase/decrease creation and execution in the same Soroban transaction. The public `execute_order` keeper recipient is not an authorizer. Our wrapper rejects unfilled entry escrow, reserves a closing execution fee and requires no new player signature to close a round-owned vault. Please identify any additional minimum collateral/notional, cooldown, closing fee, status, token authorization or report-time constraints that affect this flow. We do not assume a fixed configuration will remain unchanged.

## Reproducible environment and release handover

Provide a supported Testnet environment or a reproducible official release deployment with equivalent payment semantics: market/vault/oracle/verifier/token addresses, source commit, compiled WASM hashes, ABI, market/feed scales, funded test assets/liquidity and valid test reports. A mock local accounting getter is insufficient to certify the deployed Zenex integration. A separately modified market must not be presented as the existing market's integration.

For the release, supply the exact market and dependencies, code/configuration and upgrade authority/policy. Dogstar will pin reviewed identities; an unreviewed code change fails native execution closed. Limits and fees must be read and checked, not copied indefinitely from documentation.

## Joint acceptance before enabling prize-bearing rounds

1. Real long and short positions open and close through a contract-controlled vault with exact authorization; an unfilled/invalid entry rolls back without stranded escrow.
2. A third-party liquidation/ADL pays that vault and the authoritative paid total captures it without a Dogstar executor callback.
3. Direct token donations remain outside competitive return; large legitimate gains remain uncapped by Dogstar.
4. A failed trader delivery creates credit; a partial and final claim count each token once. A rejected or reverted transfer leaves no false successful-payment record.
5. All admitted refund paths, both remaining position sides and pending-order state agree with actual escrow/delivery. Replay, account reset and cross-trader contamination are rejected.
6. Actual signed reports pass the pinned oracle; stale/wrong-feed/invalid reports fail without leaving an opening partially committed.
7. With the venue/report path unavailable, the existing Dogstar facility can still buy the local residual rights and finish contractual player/sponsor claims without new player authorization. External recovery is retried later by the provider.

Items 1–6 establish the real venue integration. Item 7 tests Dogstar's independently funded exit mechanism. The cumulative getter alone does not guarantee cash availability, remove a market freeze, insure unknown future gains or complete production security review. Existing venue profit/ADL/collateral rules remain in force.

## Evidence and primary references

The current market hash still matches `02aa342f5e6e084c8e5728b74aee77864f77ea720896e61a689da8252f95943c`; its ABI lacks the proposed getter. [Current on-chain identity recheck](evidence/zenex-live-code-recheck-2026-10-30.json) and [ABI inspection](evidence/zenex-interface-inspection-2026-10-30.json) are read-only and signed no Mainnet transaction.

- [Official deployments](https://github.com/zenith-protocols/zenex-docs/blob/main/docs/deployments.md)
- [Trader settlements and failed-payout credit](https://github.com/zenith-protocols/zenex-docs/blob/main/technical/market/fee-system.md)
- [Funding and partial credit claims](https://github.com/zenith-protocols/zenex-docs/blob/main/technical/market/funding-rate.md)
- [Order authorization, refunds and atomic fills](https://github.com/zenith-protocols/zenex-docs/blob/main/technical/market/orders.md)
- [Full signed reports and keeper access](https://github.com/zenith-protocols/zenex-docs/blob/main/integrations/price-feed.md)
