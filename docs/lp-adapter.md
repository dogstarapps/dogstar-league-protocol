# Isolated Soroswap liquidity positions

Implemented and admitted on the official Soroswap Testnet pair. Mainnet admission remains open. The wrapper conforms to tournament ABI 0.4.0 through `CAP_LP | CAP_POSITION` (18). It uses the deployed Soroswap router/factory/pair ABI, not a generic single-asset pool mock. Fetched third-party binaries remain local and are not redistributed.

The adapter fixes one pair, its two token addresses, router/factory/pair code hashes, conversion adapter, vault implementation and minimum independent entry value. Each position owns its actual LP shares in a separate immutable vault. The root's existing cash coverage and closing-reward reservation apply atomically before an opening can commit.

Opening splits the cash budget between the two legs, enforces independent conversion floors, synchronizes pre-existing pool token surplus before minting, authorizes exact optimal token pulls and measures actual share/input deltas. Unused converted balances remain recorded position components. The minted share claim plus those idle components must meet the configured independent cash-value floor. The caller supplies minimum token conversion outputs and a minimum LP quantity. The current implementation requires an existing liquid pair.

Closing burns only the recorded LP quantity, measures actual token receipts and converts the owned components to cash. Idle donations directly to the vault and extra donated LP shares are excluded. Soroswap withdrawal may burn LP shares that somebody previously sent to the pair itself, so competitive recovery is capped at our recorded share of the pair's pre-withdrawal reserves. Additional receipts stay outside the round's competitive accounting. Unsynchronized pool token surplus is similarly excluded from that bound. Exact principal/cash amounts use integers and I256 intermediate ratios.

Pool state already synchronized by third parties can incorporate gifts as LP value. Economic self-trading can also generate protocol fees. This wrapper does not claim to eliminate every market-manipulation or collusion strategy. Mainnet campaign admission needs liquidity/exposure limits, independent valuation and economic review; a publicly funded prize pool is not a Sybil-resistant incentive program.

The vault hands over local ownership to the funded exit provider without calling the router, pair or external tokens. A frozen external route therefore cannot prevent the contractual cash purchase. The provider may later retry native withdrawal or recover the fungible LP shares to its own address. Normal close transfers remaining vault ownership to the player for separately recoverable donations; such assets do not inflate competitive return.

Five local fixture tests exercise share/cash accounting, NAV growth, rejection and full rollback of a bad mint, unsolicited vault/pair assets, and provider handover/share recovery while the router is frozen. Actual wrapper WASM is used; authorization bypasses are disabled during the tested strategy calls. These fixture tests cover failure cases separately from the successful live Testnet lifecycle below. They do not establish installed-wallet signing or Mainnet approval.

The official Testnet route now uses the real direct router/pair conversion and an independent external Reflector reference. No dummy aggregator is labeled live. The admitted manifest is `deployments/testnet-v5-lp.json`; its public evidence records actual opening/closing resources and provider funding. Mainnet needs its own reviewed route, independent prices, exposure limits and funded commitments.



## Read-only SDK quote and application entry

SDK `quoteLiquidityEntry` checks the current registry admission and selected wrapper code/configuration before reading the actual pair reserves, token balances, LP supply and direct-router conversion quote. For the initial direct pair with one cash leg, it projects conversion before minting, including synchronized token surplus and unused components. The quote exposes both independent conversion floors and the configured entry-value floor, exact integer minimums for both legs and LP quantity, eligibility reasons and a thirty-second review expiry. Independent failures block submission; the caller cannot turn them into a lower quote policy.

Mint quantities remain estimates: the final transaction simulation measures actual router pulls, minted units and independent value, including possible protocol-fee dilution. A quote never authorizes a protocol, guarantees execution or proves manipulation resistance. An earlier historical inspection used a different Testnet token and failed its independent floor. The later admitted pair uses the USDC address from the official Soroswap token definition. It met the unchanged floors without a setup alignment trade. No controlled replacement price feed was introduced.

Run `node scripts/inspect-lp-testnet.mjs <new-evidence.json>` after building the SDK to inspect the actual official Testnet router/factory/pair code, reserves, LP supply, conversion quote and fresh external Reflector reference. It moves no funds, preserves third-party binaries locally, refuses to overwrite evidence and never admits a protocol. The [2026-10-30 inspection](evidence/lp-market-inspection-2026-10-30.json) obtained 760260 output units for 5000000 native input units, below the 790419 independent minimum at that observation. These values are historical observations, not current quotes.


## Verified Testnet lifecycle (2026-10-30)

[Rechecked chain evidence](evidence/testnet-lp-v5-lifecycle-fees-2026-10-30.json) records two actual LP mints, one normal burn/conversion, public prefunded purchase of the other position, provider native withdrawal and all final claims. All tracked budgets and reserved/committed coverage finish at zero. The seven target-round executor transactions received 0.8 XLM against 0.0258650 XLM in charged fees, each covering its charged cost in that run. These measurements do not guarantee future keeper profitability.

The market was healthy; purchase was deliberately exercised at the deadline. Frozen-router/asset handling remains a fixture test. The provider recovered 49,849,657 native stroops from the purchased position. Testnet assets do not prove real-world backing, Mainnet liquidity, manipulation resistance or installed-wallet signing. The application quotes remain available without a wallet; opening requires an eligible live round and wallet signature.
