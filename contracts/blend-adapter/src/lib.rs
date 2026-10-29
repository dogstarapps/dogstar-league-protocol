#![no_std]
// Renew a bounded seven-day lease at the nominal five-second ledger cadence.
// Archived entries remain restorable; never prepay the network maximum on each write.
pub use dogstar_vault_types::{BlendSettings, VaultContext};
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, xdr::ToXdr, Address, Bytes,
    BytesN, Env, Executable, Vec,
};
#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    Lock,
}
#[contractclient(name = "VaultClient")]
pub trait Vault {
    fn initialize(e: Env, min_underlying: i128);
}
#[contract]
pub struct BlendAdapter;
#[contractimpl]
impl BlendAdapter {
    pub fn __constructor(e: Env, c: BlendSettings) {
        assert!(
            c.pool.executable() == Some(Executable::Wasm(c.pool_hash.clone()))
                && c.swap_adapter.executable() == Some(Executable::Wasm(c.swap_hash.clone())),
            "external_code_mismatch"
        );
        e.storage().instance().set(&Key::Config, &c);
    }
    pub fn capabilities() -> u32 {
        dogstar_protocol_types::CAP_SUPPLY | dogstar_protocol_types::CAP_POSITION
    }
    pub fn vault_wasm(e: Env) -> BytesN<32> {
        Self::config(e).vault_wasm
    }
    pub fn config(e: Env) -> BlendSettings {
        e.storage().instance().get(&Key::Config).unwrap()
    }
    pub fn open(
        e: Env,
        c: VaultContext,
        nonce: u32,
        minimums: Vec<i128>,
        request: Bytes,
    ) -> Address {
        c.round.require_auth();
        assert!(
            minimums.len() == 1 && request.is_empty(),
            "invalid_supply_request"
        );
        assert!(
            c.adapter == e.current_contract_address(),
            "adapter_context_mismatch"
        );
        assert!(
            !e.storage().instance().get(&Key::Lock).unwrap_or(false),
            "reentrant"
        );
        e.storage().instance().set(&Key::Lock, &true);
        let s = Self::config(e.clone());
        assert!(c.cash == s.cash && c.basis > 0, "invalid_cash");
        let salt: BytesN<32> = e
            .crypto()
            .sha256(&(c.round.clone(), c.player.clone(), nonce).to_xdr(&e))
            .into();
        let vault = e
            .deployer()
            .with_current_contract(salt)
            .deploy_v2(s.vault_wasm.clone(), (s, c.clone()));
        token::Client::new(&e, &c.cash).transfer(&e.current_contract_address(), &vault, &c.basis);
        VaultClient::new(&e, &vault).initialize(&minimums.get(0).unwrap());
        e.storage().instance().set(&Key::Lock, &false);
        let n = e.storage().max_ttl().min(120_960);
        e.storage().instance().extend_ttl(n / 2, n);
        vault
    }
}

#[cfg(test)]
mod test;
