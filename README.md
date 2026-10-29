# Dogstar League protocol

Open-source Soroban contracts, protocol adapter interfaces, TypeScript SDK and public Testnet executor for sponsored trading rounds. The Dogstar League application and backoffice are developed separately. This repository contains no frontend, brand assets, user data, credentials or private application history.

## Development

Use Node 24.22.1, Rust and the `wasm32v1-none` target. Check the destination disk budget before installing dependencies or compiling on a shared machine.

```sh
npm ci --ignore-scripts
npm run build:contracts
npm run bindings
npm run check:bindings
npm run typecheck
npm test
npm run build
npm run test:contracts
```

Contract deployment tests use the current compiled WASM. Generate current 0.3.0 bindings after contract changes; retained 0.2.0 schemas support already-deployed immutable rounds. Deployment manifests pin actual network addresses, code hashes and interface hashes. The SDK rejects incompatible interfaces, another network and changed deployed code. Compiler versions can affect WASM hashes; bind a deployment to its own build artifacts rather than assuming every compiler produces the same binary.

## Components

- `contracts/tournament`: token custody, signed consent, calendars, registration, funding, Spot execution, limit reservations, settlement and fixed-recipient claims.
- `contracts/registry`: immutable protocol versions, capabilities, code-hash admission and selection pause.
- `contracts/factory`: round deployment and indexed configuration/metadata commitments.
- `contracts/spot-adapter`: immutable Aquarius, Sushi and Soroswap routes through the aggregator wire interface, exact nested authorization and actual balance deltas.
- `contracts/exit-facility`, `contracts/spot-receipt`: aggregate reserved exit cash, signed provider terms, explicit strike/premium accounting and residual ownership handover without external venue calls.
- `contracts/price-policy`: independent SEP-40 prices, fixed token/feed mappings, freshness, timestamp skew and decimal validation.
- `packages/sdk`: generated WASM schemas, deployment compatibility, typed snapshots, canonical metadata, wallet signing, pending outcomes and restoration preparation.
- `packages/executor`: permissionless Testnet planning/submission with an operator-owned signer and persistent pending-envelope journal.
- `packages/core`: browser-safe reference simulation and economic invariants; its demo state is never authoritative for live execution.

Protocol IDs, addresses and capabilities come from the registry and deployment manifest. The live SDK does not use the simulation's fixed protocol catalog as admission authority.

## Run an executor

```sh
npm run executor -- --manifest=deployments/testnet.json --key-file=/private/operator.secret --journal=.local/executor.sqlite --fee-budget-stroops=100000000 --max-fee-stroops=10000000 --min-surplus-stroops=1000 --once
```

The operator supplies their own funded Testnet account and a secret file with mode `0600`. Each operator has their own journal. No Dogstar API or exclusive operator key is required. Signed envelopes are persisted before broadcast. A pending outcome is reconciled by hash, or the exact same signed envelope is rebroadcast; the executor does not rebuild an ambiguous operation. All eligibility and rewards are checked by contracts. The default signing budget is zero; fee caps and the cumulative journal allowance are denominated in native XLM stroops. The executor compares assembled fees with eligible native rewards before signing. `--allow-unprofitable` explicitly permits bounded Testnet maintenance and restoration; it does not bypass the fee cap or cumulative allowance. Failed or ambiguous spend remains allocated conservatively. Ledger races can still cost fees.

## Implementation boundary

This is development software. Local external-market and oracle fixtures do not certify a live venue. Isolated Blend/Zenex ownership, protocol-specific final exits, live venue admission, scalability and production reviews remain tracked in [implementation status](docs/STATUS.md). Mainnet signing is disabled. A final buyout must assign enforceable residual rights against prefunded aggregate obligations; it cannot unfreeze an external protocol.

Player positive profit is calculated individually, separately from sponsor principal. The default share is 100%; configurable shares are immutable round terms. Arbitrary rounds have no MyLab, TERRY, POWER or HAW-AI authority.

## License

Original code: [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for third-party interfaces and attributions. Dogstar names, logos and artwork are not licensed by this source-code license. Dependencies retain their own licenses. No fetched third-party implementation WASM is redistributed here.
