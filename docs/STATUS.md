# Implementation status

Development source: 0.3.0. The public protocol remains separate from the private application/backoffice. Mainnet signing is disabled.

## Verified implementation

Registry/factory admission, custody, signed consent, separate capital/prize/execution budgets, five-seat preparation batches, immutable terms, actual Spot deltas, limit reservations and fixed-recipient cash claims are implemented. The earlier native-cash lifecycle completed on Testnet; its [public chain receipts](evidence/testnet-cash-lifecycle-2026-10-29.json) describe ABI 0.2.0 and certify no external venue.

ABI 0.3.0 adds a prefunded exit facility and immutable Spot receipts. Coverage is reserved against recorded cash cost before new exposure can commit. Provider funding signs the exact round terms; reserved cash cannot be withdrawn. Native exits retain their full gain and release coverage. After the purchase deadline, the round receives the agreed native-cash strike and assigns residual rights without invoking the external venue or asset. A frozen residual token can remain unavailable to its new provider owner while player settlement completes.

Local tests exercise an unavailable venue, a frozen external asset, aggregate coverage failure with full trade rollback, public closure without player authorization, residual redemption/retry, partial basis release, explicit premiums, provider consent and uncapped native gains. These tests are not deployed Blend/Zenex/LP certification.

Limits now have bounded active indices (10 per player), reserved premiums, paid expiry batches up to 20 and owner-specific contribution pages. Cash asset closure has an operator reward; constructor budgets reserve worst-case Spot closure, participant settlement and calendar/preparation work. Funding sealing is rewarded. Contributors can refund objectively failed funding or expired preparation without waiting for a keeper.

The executor supports the versioned active-order/expiry/buyout paths, attempts independent player/asset progress, checks assembled fees against native rewards and explicit caps, and records a cumulative pessimistic fee allocation atomically with each signed envelope. Default signing allowance is zero. Unprofitable maintenance/restoration requires an explicit allowance and shares the persistent budget. Pending/expired envelopes do not silently replenish that allowance. This reduces operator loss; competition and ledger timing can still cause failed transactions and gas costs.

Generated ABI 0.2.0 remains available for immutable old deployments. Current 0.3.0 schemas come from actual compiled WASM, with an interface-drift check. A new manifest selects 0.3.0 explicitly; applying its ABI to an old factory is rejected. Existing deployment/evidence files are preserved.

The separate private application is connected to the cash Testnet deployment. It includes creation/funding/consent/claims, committed metadata, deployment-scoped discovery, a creator workspace and verified final-result sharing. Its current SDK revision remains pinned until a reviewed update.

## Remaining integration

Real isolated Blend supply and Zenex vaults, fungible LP, live venue/pool/market admission, independent common end valuation, asynchronous external payout/donation attribution, full funding/participation access modes, provider UX, installed-wallet signing checks, production deployment/monitoring and independent security/economic review remain open. Keeper rewards need actual resource/cost measurements for each admitted route. Activity/level campaigns belong to explicit eligibility and finite incentive budgets; arbitrary rounds have no global emission authority.

The emergency strike is an explicit contingent purchase obligation. It is not a guarantee of unlimited unknown future profit, external protocol solvency or unfreezing. Providers accept residual/loss exposure and must price their commitments accordingly. See [exit purchase terms](exit-purchase-terms.md).
