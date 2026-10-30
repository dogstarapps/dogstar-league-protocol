# Immutable round access

Tournament ABI 0.6.0 adds separate funding and participation rules to the immutable configuration. Each rule is `Open`, `CreatorOnly` or `Allowlist(Vec<Address>)`. The creator signs the complete configuration before publication. Its hash is the factory's config hash, the player's consent hash and the exit facility's round terms. There is no setter, moderator override or private-server permission source.

Funding checks the authenticated token owner for every capital, prize and execution contribution. Participation checks the authenticated registering address before a seat can be reserved. A creator is not implicitly included in an explicit allowlist. Atomic creator funding rolls back publication if the funding rule excludes that creator. A list contains 1–100 unique Stellar account or contract addresses and must have enough possible participants to satisfy the minimum player count. These are wallet invitations, not proof of distinct humans. Lists are public contract data; invitation URLs are navigation, not bearer credentials.

Access rules apply only to entry and contributions. Anyone can still perform the existing public calendar, closure, cancellation, settlement and fixed-recipient claim actions. Registration withdrawal and original-owner contribution refunds remain available. Restricting participation cannot grant the creator custody or change a recipient.

SDK helpers validate rules, parse address lists, check eligibility and fail closed when current terms are missing. Older immutable ABIs retain their open contract behavior; a private API cannot retrofit enforceable invitations onto those contracts. Historical schemas and deployment manifests remain preserved. The public executor understands ABI 0.6.0 and remains independent of player/organizer allowlists.

The private frontend exposes rules before contribution/consent. Application curation is separate: a directory badge or listing decision cannot edit these terms, admit executable adapters, mint platform incentives or prevent a direct contract claim.
