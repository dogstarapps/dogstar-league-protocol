# Public Testnet executor operations

The executor uses the public RPC/contracts. It needs no Dogstar account, exclusive platform key, private indexer or custody authority. Anyone can implement the same eligible calls; contracts choose recipients and calculate rewards. A funded round execution budget is separate from an operator's wallet and its maximum signing allowance. Current code permits Testnet signing only.

## Read-only planning

```sh
npm run build
node dist/executor/src/daemon.js --manifest=deployments/testnet-v5-lp.json --manifest=deployments/testnet-v5-profile.json --plan
```

No secret or persistent journal is loaded in plan mode. At most the newest twenty rounds per factory are read. Optional `--operator=G...` changes the simulation source, not custody. Planning cannot guarantee a subsequent transaction remains eligible. Archived state can require a separately authorized restore operation.

## Autonomous signing

```sh
node dist/executor/src/daemon.js \
  --manifest=deployments/testnet-v5-lp.json \
  --manifest=deployments/testnet-v5-profile.json \
  --key-file=/private/operator.secret \
  --journal=/private/operator.sqlite \
  --fee-budget-stroops=100000000 \
  --max-fee-stroops=10000000 \
  --min-surplus-stroops=1000 \
  --interval-ms=15000 --health-port=5190
```

Use an operator-owned funded Testnet account and a mode-0600 secret file. Keep the journal persistent and private; it preserves signed envelopes and must not be reset to replenish a fee allowance. At most five unique factories share one source, journal and aggregate allowance. Do not run concurrent processes using the same source account. Different independently funded operators do not share a global lock.

The default total allowance is zero. Before signing, the executor compares assembled fees with eligible native-XLM rewards and the configured minimum surplus. Non-native rewards have zero native value unless a future reviewed conversion policy is added. `--allow-unprofitable` explicitly permits maintenance/restoration within the same finite cap; it does not make tasks profitable. Keeper competition and simulation/ledger races can still incur failed transaction fees. An operator can stop the process at any time; another eligible operator can continue public work.

## Persistence, retries and monitoring

Newest-round discovery and bounded historical backfill feed a durable factory-scoped due queue. Failed pages back off without starving known active rounds. Ledger timestamps govern calendars; host time is used only for operational retry/health intervals. Terminal rounds leave the active queue. A failed player task backs off independently of another player or the deadline purchase.

An exact signed envelope is persisted before broadcast. Pending outcomes are looked up by hash and the same envelope can be rebroadcast until expiry. If the source sequence was consumed but its receipt is absent from RPC history, the journal marks the envelope UNKNOWN and refuses to sign another sequence. The quarantine remains sticky even if a later RPC account read reports a lower sequence. Preserve it and recover authoritative history; do not treat that ambiguity as proof of expiry. Charged receipts are counted once. Allocated maximum fees are deliberately not replenished by expiry, failure or cheaper actual charges.

Loopback-only GET `/healthz` returns reports for each factory and one shared journal fee summary. GET `/readyz` returns 503 when a runner has an error, the tick is stale or a pending/unknown envelope exists. Health has no signing or action endpoint. Local application monitoring sanitizes this status and labels it self-reported. It cannot guarantee service availability or replace chain verification. Do not expose the raw health service publicly without your own access/diagnostic policy.

Optional daily factory/round/player/order upkeep requires `--allow-unprofitable`. Positions and coverage leases are renewed with player upkeep. This is not a production alerting or permanent storage guarantee; long inactive persistent state can still need restoration. Run under an operator-managed supervisor with protected persistent storage, restart/backup/alert policies and an independent signer before production. The current local development daemon is not such a deployment.

## Optional signed exit reports

`--exit-reports=/private/report-sources.json` accepts at most twenty explicit sources:

```json
[
  {
    "adapter": "C...",
    "market": "C...",
    "marketHash": "64 lowercase hexadecimal characters",
    "url": "https://your-report-broker.example/zenex/full-report",
    "authorizationEnv": "ZENEX_REPORT_AUTHORIZATION"
  }
]
```

Each source uses either `file` or `url`. A source response is `{ "fullReport": "0x..." }`, at most 64 KiB, containing up to 12,000 report bytes. HTTPS or explicit loopback HTTP is accepted; redirects and credentials/query strings in URLs are rejected. Credentials stay in a server-only environment variable. Adapter admission/code and its pinned market/hash are checked before reading a report. The venue's oracle verifies the bytes; an HTTP broker has no pricing, custody or ranking authority.

The executor first simulates native closure with no report, allowing already settled forced positions to finish. A report is fetched only if needed. Once the purchase deadline arrives, report acquisition and venue simulation are bypassed. This plumbing does not admit the currently incompatible Zenex market; see [the required venue extension](zenex-adapter.md).


The [independent-account Testnet lifecycle](evidence/testnet-independent-executor-lifecycle-2026-10-30.json) records public funding, two consents, all seven automatic transitions/settlements, and all participant/contributor claims. The actor process did not submit executor tasks. This verifies a local autonomous service, not a production supervisor or global operator network.
