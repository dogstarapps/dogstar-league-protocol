# Implementation status

Development source: 0.4.0. The public protocol remains separate from the private application/backoffice. Mainnet signing is disabled.

## Verified implementation

Registry/factory admission, custody, signed consent, separate capital/prize/execution budgets, five-seat preparation batches, immutable terms, actual Spot deltas, limit reservations and fixed-recipient cash claims are implemented. The earlier native-cash lifecycle completed on Testnet; its [public chain receipts](evidence/testnet-cash-lifecycle-2026-10-29.json) describe ABI 0.2.0 and certify no external venue.

ABI 0.3.0 adds a prefunded exit facility and immutable Spot receipts. Coverage is reserved against recorded cash cost before new exposure can commit. Provider funding signs the exact round terms; reserved cash cannot be withdrawn. Native exits retain their full gain and release coverage. After the purchase deadline, the round receives the agreed native-cash strike and assigns residual rights without invoking the external venue or asset. A frozen residual token can remain unavailable to its new provider owner while player settlement completes.

Local tests exercise an unavailable venue, a frozen external asset, aggregate coverage failure with full trade rollback, public closure without player authorization, residual redemption/retry, partial basis release, explicit premiums, provider consent and uncapped native gains. These tests are not deployed Blend/Zenex/LP certification.

Limits now have bounded active indices (10 per player), reserved premiums, paid expiry batches up to 20 and owner-specific contribution pages. Cash asset closure has an operator reward; constructor budgets reserve worst-case Spot closure, participant settlement and calendar/preparation work. Funding sealing is rewarded. Contributors can refund objectively failed funding or expired preparation without waiting for a keeper.

The executor supports the versioned active-order/expiry/buyout paths, attempts independent player/asset progress, checks assembled fees against native rewards and explicit caps, and records a cumulative pessimistic fee allocation atomically with each signed envelope. Default signing allowance is zero. Unprofitable maintenance/restoration requires an explicit allowance and shares the persistent budget. Pending/expired envelopes do not silently replenish that allowance. This reduces operator loss; competition and ledger timing can still cause failed transactions and gas costs.

Generated ABI 0.2.0 and 0.3.0 remain available for immutable old deployments. Current 0.4.0 schemas come from actual compiled WASM, with an interface-drift check. A new manifest selects 0.4.0 explicitly; applying its ABI to an old factory is rejected. Existing deployment/evidence files are preserved.

The separate private application is connected to the cash Testnet deployment. It includes creation/funding/consent/claims, committed metadata, deployment-scoped discovery, a creator workspace and verified final-result sharing. Its current SDK revision remains pinned until a reviewed update.

## Remaining integration

Zenex vaults, fungible LP, Mainnet venue/pool/market admission, independent common end valuation, asynchronous external payout/donation attribution, full funding/participation access modes, provider UX, installed-wallet signing checks, production deployment/monitoring and independent security/economic review remain open. Keeper rewards need actual resource/cost measurements for each admitted route. Activity/level campaigns belong to explicit eligibility and finite incentive budgets; arbitrary rounds have no global emission authority.

The emergency strike is an explicit contingent purchase obligation. It is not a guarantee of unlimited unknown future profit, external protocol solvency or unfreezing. Providers accept residual/loss exposure and must price their commitments accordingly. See [exit purchase terms](exit-purchase-terms.md).


## Resource cost and supply-vault work

The maximum-TTL write policy produced an observed 244.8589295 XLM Testnet creation estimate. Bounded renewable leases reduced the comparable estimate to 0.0311369 XLM. Neither estimate is a Mainnet fee guarantee. The rejected high-fee attempt was not signed or submitted. Leases are nominally seven days at a five-second ledger cadence; persistent entries remain restorable and require maintenance/restoration integration for long inactive periods.

A Blend supply adapter and per-position vault compile against the actual fetched pool ABI. They use supply/withdraw request kinds 0/1, track actual internal b-share quantities, reject debt/collateral, measure withdrawal and conversion deltas, exclude idle donated cash from competitive recovery and support local handover while the pool is unavailable. Three standalone fixture tests passed without a global authorization bypass during actual supply/withdrawal calls. Incentive-token claims after normal exit belong to the player; they are separate from competitive cash return.

ABI 0.4.0 integrates these vaults into tournament accounting through a standard position interface. Admission checks capability masks against adapter code; only position-capable adapters can open vaults. A player may hold up to eight active positions, each with aggregate cash coverage and a reserved closing reward. Native and emergency closes remove the position once, release its reward reservation and require no new player signature during settlement. Player-initiated exits do not earn a closing bounty. Permissionless maintenance renews the position index, child vault and coverage reservation together. Request payloads are bounded to 16 KiB.

42 Rust tests passed, including actual own Blend vault/adapter WASMs embedded in tournament tests, aggregate capacity rollback, frozen-pool purchase with operator-only authorization and lease renewal. 37 TypeScript tests passed, including version selection, blocked-player progress and deadline fallback planning. These fixture tests do not establish Mainnet readiness.

The official Blend v2 Testnet pool and its active XLM reserve have been read on chain. Its fetched code matches the hash published by Blend. The native-XLM-only adapter has been admitted to the new Testnet registry; [admission evidence](evidence/blend-testnet-admission-2026-10-29.json) records the addresses and transaction. The official pool uses a test oracle. This is not a Mainnet deployment or a completed live-position lifecycle claim.
