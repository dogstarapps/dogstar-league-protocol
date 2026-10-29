#![no_std]
// Renew a bounded seven-day lease at the nominal five-second ledger cadence.
// Archived entries remain restorable; never prepay the network maximum on each write.
use dogstar_protocol_types::{ProtocolSelection, ProtocolVersion};
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, Address, BytesN, Env, Executable, Symbol,
    Vec,
};
#[contracttype]
#[derive(Clone)]
enum Key {
    Admin,
    Count,
    Index(u32),
    Protocol(Symbol, u32),
    Paused(Symbol, u32),
}
#[contractevent]
#[derive(Clone)]
pub struct ProtocolAdmitted {
    #[topic]
    pub id: Symbol,
    #[topic]
    pub version: u32,
    pub adapter: Address,
    pub wasm_hash: BytesN<32>,
}
#[contract]
pub struct Registry;
fn ttl(e: &Env, k: &Key) {
    let n = e.storage().max_ttl().min(120_960);
    e.storage().persistent().extend_ttl(k, n / 2, n);
    e.storage().instance().extend_ttl(n / 2, n);
}
#[contractimpl]
impl Registry {
    pub fn __constructor(e: Env, admin: Address) {
        admin.require_auth();
        e.storage().instance().set(&Key::Admin, &admin);
        e.storage().instance().set(&Key::Count, &0u32);
    }
    pub fn admit(e: Env, record: ProtocolVersion) {
        let admin: Address = e.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        assert!(
            record.version > 0 && record.capabilities > 0,
            "invalid_capabilities"
        );
        assert!(
            record.adapter.executable() == Some(Executable::Wasm(record.wasm_hash.clone())),
            "adapter_code_mismatch"
        );
        let key = Key::Protocol(record.id.clone(), record.version);
        assert!(!e.storage().persistent().has(&key), "immutable_version");
        e.storage().persistent().set(&key, &record);
        ttl(&e, &key);
        let count: u32 = e.storage().instance().get(&Key::Count).unwrap();
        let index = Key::Index(count);
        e.storage().persistent().set(
            &index,
            &ProtocolSelection {
                id: record.id.clone(),
                version: record.version,
            },
        );
        ttl(&e, &index);
        e.storage().instance().set(&Key::Count, &(count + 1));
        ProtocolAdmitted {
            id: record.id,
            version: record.version,
            adapter: record.adapter,
            wasm_hash: record.wasm_hash,
        }
        .publish(&e);
    }
    pub fn get(e: Env, id: Symbol, version: u32) -> ProtocolVersion {
        let key = Key::Protocol(id, version);
        let r: ProtocolVersion = e.storage().persistent().get(&key).unwrap();
        ttl(&e, &key);
        r
    }
    pub fn set_paused(e: Env, id: Symbol, version: u32, paused: bool) {
        let admin: Address = e.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        let _ = Self::get(e.clone(), id.clone(), version);
        let k = Key::Paused(id, version);
        e.storage().persistent().set(&k, &paused);
        ttl(&e, &k);
    }
    pub fn available(e: Env, id: Symbol, version: u32) -> bool {
        let r = Self::get(e.clone(), id.clone(), version);
        let key = Key::Paused(id, version);
        let paused: bool = e.storage().persistent().get(&key).unwrap_or(false);
        if e.storage().persistent().has(&key) {
            ttl(&e, &key);
        }
        !paused && r.adapter.executable() == Some(Executable::Wasm(r.wasm_hash))
    }
    pub fn page(e: Env, offset: u32, limit: u32) -> Vec<ProtocolVersion> {
        assert!(limit <= 50, "page_limit");
        let count: u32 = Self::count(e.clone());
        let mut out = Vec::new(&e);
        for i in offset..offset.saturating_add(limit).min(count) {
            let key = Key::Index(i);
            let k: ProtocolSelection = e.storage().persistent().get(&key).unwrap();
            ttl(&e, &key);
            out.push_back(Self::get(e.clone(), k.id, k.version));
        }
        out
    }
    pub fn count(e: Env) -> u32 {
        let n = e.storage().max_ttl().min(120_960);
        e.storage().instance().extend_ttl(n / 2, n);
        e.storage().instance().get(&Key::Count).unwrap()
    }
}

#[cfg(test)]
mod test;
