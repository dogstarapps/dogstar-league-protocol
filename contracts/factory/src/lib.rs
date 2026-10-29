#![no_std]
use dogstar_protocol_types::{
    Config, ExitArtifacts, ProtocolSelection, ProtocolVersion, RoundRecord,
};
use soroban_sdk::{
    contract, contractclient, contractevent, contractimpl, contracttype, xdr::ToXdr, Address,
    BytesN, Env, Symbol, Vec,
};
#[contractclient(name = "RegistryClient")]
pub trait Registry {
    fn get(e: Env, id: Symbol, version: u32) -> ProtocolVersion;
    fn available(e: Env, id: Symbol, version: u32) -> bool;
}
#[contracttype]
#[derive(Clone)]
enum Key {
    Registry,
    RoundWasm,
    QuotePolicy,
    Cash,
    ExitArtifacts,
    Count,
    Round(u32),
    ByAddress(Address),
    Salt(Address, BytesN<32>),
}
#[contractevent]
#[derive(Clone)]
pub struct RoundCreated {
    #[topic]
    pub id: u32,
    #[topic]
    pub address: Address,
    pub creator: Address,
    pub metadata_hash: BytesN<32>,
}
#[contract]
pub struct Factory;
#[contractimpl]
impl Factory {
    pub fn __constructor(
        e: Env,
        registry: Address,
        round_wasm: BytesN<32>,
        quote_policy: Address,
        cash: Address,
        exit_artifacts: ExitArtifacts,
    ) {
        e.storage().instance().set(&Key::Registry, &registry);
        e.storage().instance().set(&Key::RoundWasm, &round_wasm);
        e.storage().instance().set(&Key::QuotePolicy, &quote_policy);
        e.storage().instance().set(&Key::Cash, &cash);
        e.storage()
            .instance()
            .set(&Key::ExitArtifacts, &exit_artifacts);
        e.storage().instance().set(&Key::Count, &0u32);
    }
    pub fn create(
        e: Env,
        c: Config,
        selections: Vec<ProtocolSelection>,
        salt: BytesN<32>,
        metadata_hash: BytesN<32>,
    ) -> Address {
        c.creator.require_auth();
        let cash: Address = e.storage().instance().get(&Key::Cash).unwrap();
        assert!(c.cash == cash, "unapproved_settlement_asset");
        let approved: ExitArtifacts = e.storage().instance().get(&Key::ExitArtifacts).unwrap();
        if let Some(exit) = c.exit.terms() {
            assert!(approved == exit.artifacts, "unapproved_exit_contracts");
        } else {
            assert!(
                c.adapters.is_empty() && c.assets.len() == 1,
                "exit_coverage_required"
            );
        }
        assert!(
            selections.len() == c.adapters.len() && selections.len() <= 5,
            "adapter_selection_mismatch"
        );
        let policy: Address = e.storage().instance().get(&Key::QuotePolicy).unwrap();
        assert!(c.quote_policy == policy, "unapproved_quote_policy");
        let salt_key = Key::Salt(c.creator.clone(), salt.clone());
        assert!(
            !e.storage().persistent().has(&salt_key),
            "salt_already_used"
        );
        let registry: Address = e.storage().instance().get(&Key::Registry).unwrap();
        let client = RegistryClient::new(&e, &registry);
        let mut protocols = Vec::new(&e);
        let mut adapters = Vec::new(&e);
        for selection in selections.iter() {
            assert!(
                client.available(&selection.id, &selection.version),
                "protocol_not_available"
            );
            let p = client.get(&selection.id, &selection.version);
            assert!(
                c.adapters.contains(&p.adapter) && !adapters.contains(&p.adapter),
                "invalid_adapter"
            );
            adapters.push_back(p.adapter.clone());
            protocols.push_back(p);
        }
        let hash: BytesN<32> = e
            .crypto()
            .sha256(&(c.creator.clone(), salt).to_xdr(&e))
            .into();
        let wasm: BytesN<32> = e.storage().instance().get(&Key::RoundWasm).unwrap();
        let config_hash: BytesN<32> = e.crypto().sha256(&c.clone().to_xdr(&e)).into();
        let address = e
            .deployer()
            .with_current_contract(hash)
            .deploy_v2(wasm, (c.clone(),));
        let id: u32 = e.storage().instance().get(&Key::Count).unwrap();
        let record = RoundRecord {
            id,
            address: address.clone(),
            creator: c.creator.clone(),
            metadata_hash: metadata_hash.clone(),
            config_hash,
            protocols,
            created_at: e.ledger().timestamp(),
        };
        let k = Key::Round(id);
        e.storage().persistent().set(&k, &record);
        e.storage()
            .persistent()
            .set(&Key::ByAddress(address.clone()), &id);
        e.storage().persistent().set(&salt_key, &address);
        let n = e.storage().max_ttl();
        for key in [k, salt_key, Key::ByAddress(address.clone())] {
            e.storage().persistent().extend_ttl(&key, n / 2, n);
        }
        e.storage().instance().set(&Key::Count, &(id + 1));
        e.storage().instance().extend_ttl(n / 2, n);
        RoundCreated {
            id,
            address: address.clone(),
            creator: c.creator,
            metadata_hash,
        }
        .publish(&e);
        address
    }
    pub fn get(e: Env, id: u32) -> RoundRecord {
        let k = Key::Round(id);
        let r = e.storage().persistent().get(&k).unwrap();
        let n = e.storage().max_ttl();
        e.storage().persistent().extend_ttl(&k, n / 2, n);
        e.storage().instance().extend_ttl(n / 2, n);
        r
    }
    pub fn count(e: Env) -> u32 {
        let n = e.storage().max_ttl();
        e.storage().instance().extend_ttl(n / 2, n);
        e.storage().instance().get(&Key::Count).unwrap()
    }
    pub fn find(e: Env, address: Address) -> RoundRecord {
        let key = Key::ByAddress(address);
        let id: u32 = e.storage().persistent().get(&key).unwrap();
        let n = e.storage().max_ttl();
        e.storage().persistent().extend_ttl(&key, n / 2, n);
        Self::get(e, id)
    }
    pub fn page(e: Env, offset: u32, limit: u32) -> Vec<RoundRecord> {
        assert!(limit <= 50, "page_limit");
        let mut out = Vec::new(&e);
        for id in offset..offset.saturating_add(limit).min(Self::count(e.clone())) {
            out.push_back(Self::get(e.clone(), id));
        }
        out
    }
}

#[cfg(test)]
mod test;
