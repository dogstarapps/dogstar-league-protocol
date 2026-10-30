#![no_std]
pub use dogstar_zenex_types::{VaultContext, ZenexSettings};
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, xdr::ToXdr, Address, Bytes,
    BytesN, Env, Vec,
};
#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    Lock,
}
#[contract]
pub struct ZenexAdapter;
#[contractclient(name = "VaultClient")]
pub trait Vault {
    fn initialize(e: Env, minimums: Vec<i128>, request: Bytes);
}
#[contractimpl]
impl ZenexAdapter {
    pub fn __constructor(e: Env, c: ZenexSettings) {
        assert!(
            c.max_leverage_bps >= 10000
                && c.max_leverage_bps <= 1_000_000
                && c.close_fee_reserve >= 0,
            "invalid_risk_limits"
        );
        e.storage().instance().set(&Key::Config, &c);
    }
    pub fn capabilities() -> u32 {
        24
    }
    pub fn config(e: Env) -> ZenexSettings {
        e.storage().instance().get(&Key::Config).unwrap()
    }
    pub fn vault_wasm(e: Env) -> BytesN<32> {
        Self::config(e).vault_wasm
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
            c.adapter == e.current_contract_address()
                && c.basis > 0
                && minimums.len() == 2
                && request.len() <= 16384,
            "invalid_zenex_request"
        );
        assert!(
            !e.storage().instance().get(&Key::Lock).unwrap_or(false),
            "reentrant"
        );
        e.storage().instance().set(&Key::Lock, &true);
        let s = Self::config(e.clone());
        assert!(s.cash == c.cash, "cash_mismatch");
        let salt: BytesN<32> = e
            .crypto()
            .sha256(&(c.round.clone(), c.player.clone(), nonce).to_xdr(&e))
            .into();
        let vault = e
            .deployer()
            .with_current_contract(salt)
            .deploy_v2(s.vault_wasm.clone(), (s, c.clone()));
        token::Client::new(&e, &c.cash).transfer(&e.current_contract_address(), &vault, &c.basis);
        VaultClient::new(&e, &vault).initialize(&minimums, &request);
        e.storage().instance().set(&Key::Lock, &false);
        let n = e.storage().max_ttl().min(120_960);
        e.storage().instance().extend_ttl(n / 2, n);
        vault
    }
}
#[cfg(test)]
mod test;
