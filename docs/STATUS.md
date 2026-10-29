# Implementation status

The first public source release separates protocol code from the private application. It preserves the existing financial invariants while introducing generated ABI bindings and a signing Testnet executor.

Implemented source: registry, factory, tournament custody/consent/funding/Spot/limits/claims, immutable aggregator routes, SEP-40 quote floors, code-hash checks, canonical metadata, Testnet wallet transport, restoration preparation and durable operator reconciliation. Local tests deploy actual tournament WASM and use fixtures for external markets and oracle feeds. No live adapter certification follows from those tests.

Remaining product integration: deploy and exercise the Testnet lifecycle; connect the separate application and backoffice to generated SDK calls and reconstructible state; test installed wallets; finish isolated Blend/Zenex positions, fungible LP and aggregate prefunded final purchase commitments; implement and measure paginated preparation/settlement for the intended scale. No production claim should substitute the simulation for these integrations.

The current tournament constructor supports up to 50 participants and 10 assets. Its preparation loop is bounded by that limit. Amounts are integer token units and are not based on historical Dogstar League balances. Larger operational scale requires explicit resource measurements and pagination.

Mainnet remains disabled until protocol admission, external upgrade/freeze behavior, emergency exits, dependency review and independent security review are complete. Each deployment manifest must describe the actual network and admission evidence; demo protocol records must never be presented as live venues.
