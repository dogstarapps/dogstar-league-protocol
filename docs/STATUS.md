# Implementation status

Current SDK/executor package: 0.5.3. Tournament ABI: 0.5.0. The public protocol and private application/backoffice remain separate. Mainnet signing is disabled.

## Implemented and tested

Registry/factory code-hash admission, immutable round terms, custody, separate capital/prize/execution budgets, creator-funded atomic publication or public fundraising, player consent, bounded registration/preparation, calendar transitions, Spot execution, reserved limit orders, expiry rewards, individual positive profit shares and fixed-recipient claims are implemented. The default individual positive profit share is 100%. Arbitrary rounds have no MyLab, TERRY, POWER or HAW-AI authority.

The prefunded exit facility reserves aggregate cash before exposure opens. Native exits retain uncapped actual gains and release their coverage. After the published deadline, a public purchase pays the immutable strike and transfers local residual ownership without calling the external venue. This can complete contractual player/sponsor settlement while an external position remains unavailable to its new provider owner. It does not unfreeze a venue or insure unlimited unknown future gain. See [purchase terms](exit-purchase-terms.md).

Managed Blend supply and Soroswap LP positions use isolated immutable vaults, pinned code, exact nested authorization and actual token/share deltas. Bounded historical and owner indices expose normal player-owned and provider-acquired vaults. Independent conversion and LP entry floors, expiring integer quotes and real LP position controls are implemented. Unsolicited vault transfers do not inflate competitive recovery. Synchronized AMM gifts/self-trading remain economic admission concerns.

The wallet-controlled immutable profile registry stores optional nickname/IPFS avatar CID and revisions without an administrator, upgrade, transfer or private profile authority. Its actual Testnet sequence is recorded in [profile evidence](evidence/testnet-profiles-2026-10-30.json). AI image generation and level campaigns are separate work.

The executor discovers newest rounds and backfills bounded pages, persists scoped due work, follows ledger time, skips terminal rounds, retries failures with backoff, and attempts other available players/rounds. A failed discovery page does not starve known active work. It persists the exact signed envelope before broadcast, reconciles receipts, quarantines consumed sequences missing from history and allocates pessimistic fees against one durable allowance across up to five factories. Default allowance is zero; profitable native rewards are required unless an explicit bounded maintenance allowance is supplied. Read-only planning requires no key or disk journal. Health reporting conveys operator observations, not financial authority. See [operations](executor-operations.md).

## Actual Testnet evidence

- [Native cash lifecycle](evidence/testnet-cash-lifecycle-2026-10-29.json): historical ABI 0.2.0; certifies no external venue.
- [Blend lifecycle](evidence/testnet-blend-lifecycle-2026-10-29.json) and [creator-funded ABI 0.5.0 Blend lifecycle](evidence/testnet-creator-blend-v5-lifecycle-2026-10-29.json): real official pool supply/withdrawal, public deadline purchase, claims and provider recovery. The official Testnet pool uses a test oracle.
- [Soroswap ABI 0.5.0 LP lifecycle](evidence/testnet-lp-v5-lifecycle-fees-2026-10-30.json): 21 confirmed target-round transactions, two actual LP mints, normal burn/conversion, public deadline purchase, owner indexing, provider native withdrawal and all claims. All tracked round budgets and coverage commitments/reservations finished at zero. No setup price-alignment trade was needed. The LP manifest uses the official Soroswap Testnet token definition, distinct from the asset in the earlier failed quote inspection.

The LP executor's seven transactions received 0.8 XLM and paid 0.0258650 XLM in charged fees. Each covered its charged fee for that run. The actor and executor shared a development account in that LP lifecycle. A separate [18-transaction cash lifecycle](evidence/testnet-independent-executor-lifecycle-2026-10-30.json) subsequently verified all seven automatic calendar/settlement tasks using a different funded operator, its own persistent journal and profitable-only signing. Its creator and players supplied no closure authorization. Fee/reward observations do not establish future profitability or Mainnet prices. Both external venues were healthy; their freezes are tested with local fixtures, not fabricated as live events. An earlier LP attempt missed its short opening window, reverted atomically, and its unused funding/coverage was subsequently claimed; its private diagnostic and recovery evidence are preserved.

## Experimental Zenex integration

Seven new strict-authorization accounting tests cover long/short exits, uncapped profit, donations, liquidation/ADL-style asynchronous payouts, credit payment without double counting, unfilled-order rollback, accounting reset rejection and local handover/recovery during a frozen venue. Own adapter/vault source and typed request encoding compile. Signed-report sources can supply the complete oracle report to a public executor; the pinned venue oracle remains its verifier. Deadline purchase bypasses report acquisition and external venue calls.

The [inspected current Zenex market](evidence/zenex-interface-inspection-2026-10-30.json) has no authenticated cumulative successful payment getter. Accordingly the experimental wrapper fails closed and is **not deployed/admitted as a live Zenex route**. A fixture getter or compatible ABI alone is insufficient. The user selected venue-owned contract accounting; no external ranking certifiers were substituted. See the exact [required accounting extension](zenex-adapter.md).

## Verification and remaining work

66 Rust tests and 61 TypeScript tests passed locally. Generated schemas were checked against actual compiled WASM; immutable historical tournament ABIs remain intact. No third-party implementation binaries are redistributed. Tests/evidence verify the stated scopes and do not replace independent review.

Remaining work includes the real Zenex venue accounting extension and signed-report integration, independent common end valuation, Mainnet liquidity/exposure admission, long-inactive-state maintenance/restoration operation, full funding/participation access modes, installed-wallet end-to-end signatures, production operator deployment/alerts and independent security/economic review. Activity/level incentives require explicit eligibility and finite budgets. Current local services and Testnet balances are development infrastructure, not a production fleet or availability guarantee.
