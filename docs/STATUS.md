# Implementation status

The first public source release separates protocol code from the private application. It preserves the existing financial invariants while introducing generated ABI bindings and a signing Testnet executor.

Implemented source: registry, factory, tournament custody/consent/funding/Spot/limits/claims, immutable aggregator routes, SEP-40 quote floors, code-hash checks, canonical metadata, Testnet wallet transport, restoration preparation and durable operator reconciliation. Local tests deploy actual tournament WASM and use fixtures for external markets and oracle feeds. No live adapter certification follows from those tests.

The native cash lifecycle has now completed on Testnet: creation, three funding buckets, two signed registrations, public calendar transitions, player settlement, finalization and player/contributor claims. [Public chain receipts](evidence/testnet-cash-lifecycle-2026-10-29.json) identify the actual contracts and transactions. The cash-only policy rejects every trading pair and certifies no venue.

Remaining product integration: connect and verify the separate application/backoffice against these SDK calls; test installed wallets; finish isolated Blend/Zenex positions, fungible LP and aggregate prefunded final purchase commitments; measure the intended scale and complete exit/admission review. No production claim should substitute the simulation for these integrations.

The current tournament constructor supports up to 50 participants and 10 assets. Preparation allocates five seats per transaction with idempotent progress. Sponsor capital remains refundable if partial preparation later cancels; already-paid preparation rewards are deducted from pro rata execution refunds. Contributions and orders have bounded read pages. Amounts are integer token units and are not based on historical Dogstar League balances. Larger scale still requires explicit resource measurements.

Mainnet remains disabled until protocol admission, external upgrade/freeze behavior, emergency exits, dependency review and independent security review are complete. Each deployment manifest must describe the actual network and admission evidence; demo protocol records must never be presented as live venues.
