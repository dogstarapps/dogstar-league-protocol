# Experimental Zenex position wrapper

Status: source, generated independent ABI and local tests implemented; **no live Zenex admission**. The inspected Mainnet market `CAOZCITWHWAXH5FRU4EULQ5EN2HMTCHICRNC4R5ZAOVD7XHCCQSJ42IB`, code `02aa342f5e6e084c8e5728b74aee77864f77ea720896e61a689da8252f95943c`, lacks the required accounting getter. Inspection was read-only. Its fetched implementation WASM remains local. [Inspection evidence](evidence/zenex-interface-inspection-2026-10-30.json) is tied to that hash.

## Required venue-owned accounting

`get_trader_state(user: Address) -> TraderState` must expose this exact independently versioned structure from the actual market:

| Field | Type | Meaning |
| --- | --- | --- |
| version | u32 | Accounting ABI 1 |
| epoch | BytesN<32> | Immutable accounting epoch; a reset invalidates an existing vault |
| sequence | u64 | Monotonic sequence of accounting transitions |
| paid | i128 | Cumulative successful settlement-token payments to this trader |
| credit | i128 | Current unpaid trader credit |
| long_notional | i128 | Remaining long notional |
| short_notional | i128 | Remaining short notional |
| pending_orders | u32 | Current orders that can still alter this account |

`paid` must include ordinary exits, successful liquidation/ADL payments, trader refunds and successfully claimed funding/settlement credits. It excludes unpaid credit, donations and keeper/treasury fees. Failed transfers accrue credit without increasing `paid`; a successful later claim increases `paid` once and decreases credit atomically. All values must be venue-owned authenticated state updated consistently with actual transfers, including external keeper transactions. Indexers, wallet balances, events supplied by callers and signed price reports cannot populate this accounting authority.

The market must not reset the cumulative paid counter for a vault, decrement it, allow trader-supplied values or silently change its settlement token/accounting semantics. A compatible ABI is a preliminary check, not an admission decision. Admission also requires source review, deployed code identity, payment/failure integration tests and real signed oracle reports. We cannot modify another party's deployed market; a separate modified market with independent liquidity is a different product.

## Position lifecycle

The immutable adapter binds settlement/cash tokens, market/code, swap/code, vault/code, maximum leverage and a closing-fee reserve. It deploys a separate vault per round/player/nonce and transfers the exact basis. Entry requires a complete bounded price report, positive price bound, positive notional, independent conversion minimum and minimum actual margin. The wrapper reserves the configured closing fee, escrows margin plus the market execution fee and creates/fills a market increase atomically. Any resting/unfilled order, opposing position, incorrect notional or unexpected escrow delta rolls the whole transaction back.

Native exit reads the authenticated state, atomically fills a full market decrease if needed and claims outstanding credit. It requires both sides flat, zero pending orders and zero unpaid credit. Competitive recovery is the tracked idle reserve plus the cumulative successful payment delta minus the closing fee paid by this vault. Unsolicited token donations are excluded and actual gains are uncapped. Account epoch, cumulative payments and sequence cannot move backwards. Tokens are converted through the pinned swap adapter and independent policy; token/cash identity and code changes are rejected.

A forced close occurring before our own exit can already have paid the vault. Its cumulative payment remains counted, while claimable credit is counted only once it is paid. Any unpaid credit or frozen native exit blocks native completion; it does not block the independently funded cash purchase.

## Oracle reports and permissionless closure

The actual market requires the complete signed price report, not a ticker or decoded display price. `encodeZenexOpenRequest` and `encodeZenexCloseRequest` encode bounded XDR requests from those bytes. The executor can read a local report file or HTTPS broker using operator-owned credentials; the market's pinned oracle verifies signatures, feed, timestamp and market execution constraints on chain. Missing/invalid reports cause native closure to retry. A position already forced flat can settle without fetching a new report.

After the round's purchase deadline the executor immediately selects the cash purchase, without calling the report service, market or external tokens. The facility transfers local vault ownership to the provider and pays the committed strike. `info`, `controller`, `handover` and `keepalive` do not call the venue. The new owner can recover local tokens even while the venue is frozen and retry external recovery later. No new player wallet signature is required for contractual settlement. The purchase cannot unlock a frozen market or guarantee all unknown future profit.

## Reproducible checks

Build the own WASMs before Rust tests; seven strict-authorization tests cover normal long/short exits, gain/donation accounting, forced payments and credits, incomplete claims plus frozen ownership handover, unfilled entry rollback/retry, unsupported/reset accounting and unauthorized calls. SDK tests cover request encoding and rejection of the missing actual getter. `node scripts/inspect-zenex.mjs <fetched-market.wasm> <new-evidence-path>` inspects the already fetched real WASM without signing or changing registry admission. Report configuration is described in the [executor runbook](executor-operations.md).

Live enablement requires the actual venue extension, real oracle access and a separately reviewed admission. No threshold of ranking certifiers was introduced.


The actionable [venue integration request](zenex-integration-request.md) distinguishes the mandatory payment semantics from the negotiable API shape and defines joint acceptance tests. The exact combined getter is used by the current prototype; an equivalent authenticated cumulative paid view can be composed with existing venue views after a reviewed adapter change.
