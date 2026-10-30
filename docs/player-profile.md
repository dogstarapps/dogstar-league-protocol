# Wallet-controlled player profiles

The independent profile ABI 1 stores a profile for each Stellar address. `set_profile(owner,nickname,avatar_cid,expected_revision)` requires that address's authorization and increments a revision. Concurrent stale edits fail atomically. `get` returns an optional profile; `get_many` preserves input order and permits at most twenty addresses. Display names are deliberately non-unique, 1–32 ASCII letters/numbers and internal spaces, dots, underscores or hyphens. They start/end with a letter or number; clients retain the canonical wallet address for disambiguation.

No administrator, upgrade, reassignment, transfer, issuer revocation or arbitrary score method exists. The contract is separate from tournament custody and does not confer TERRY, MyLab, global progress or prize authority. Profile creation is optional for joining rounds. A wallet's own key rotation/account recovery is outside this registry; cross-address migration is not implemented.

Avatar references are empty or canonical CIDv1 lower-case base32 identifiers for raw sha2-256 blocks. The SDK creates these directly from PNG/JPEG bytes and checks hashes before rendering. This initial format is intentionally narrower than arbitrary IPFS UnixFS/directory paths: callers cannot substitute an HTTP URL or unverified gateway response. The uploader uses raw blocks no larger than 1 MiB for standard Bitswap interoperability; images are limited to 2048×2048 pixels. Full media availability and preservation are separate from on-chain authorization.

The immutable profile deployment is pinned by address, interface and code hash in a public manifest. Tournament ABI 0.5.0 remains unchanged and existing factory/round manifests remain preserved. The profile SDK binding is independently generated from the compiled `dogstar_player_profile.wasm` and included in interface-drift verification.

`keepalive(owner)` is permissionless, renews only an existing profile and gives no editing power. Persistent storage uses a bounded seven-day nominal lease; archived entries need restoration. Renewal, restoration and image pinning incur costs and must be funded explicitly. Application indices are optional caches, not authorities for the profile.

The Testnet manifest `testnet-v5-profile.json` selects the current batched-read profile. `testnet-v5-profile-prototype.json` preserves the earlier unintegrated deployment before batched reads were added; it is not the application identity registry. Five profile tests cover authorization/impersonation, revision conflicts, non-unique names, canonical metadata bounds and permissionless maintenance/bounded reads. All 59 Rust and 43 TypeScript tests passed with the current source. Application/media integration and its actual lifecycle proof are maintained separately.


## Actual registry verification (2026-10-30)

The deployed batched-read profile ABI 1 passed a four-transaction Testnet sequence: two wallet-authorized creations, an owner-authorized revision changing nickname/avatar CID, and a third-party keepalive. A stale expected revision was rejected by the actual contract simulation. The final state retains each correct owner and revision. All four transaction statuses and charged fees were rechecked through RPC before exporting `docs/evidence/testnet-profiles-2026-10-30.json`. The sequence uses synthetic development identities and does not certify a browser wallet signature or production IPFS hosting.

Observed Testnet fees were 0.0044514/0.0043644 XLM for the two creations, 0.0005443 XLM for the update and 0.0001990 XLM for keepalive. These are measured Testnet transactions, not Mainnet price guarantees. The private application separately checks actual image pins, byte hashes, profile-aware result rendering and reading while its own API is unavailable.
