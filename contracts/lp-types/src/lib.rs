#![no_std]
pub use dogstar_vault_types::VaultContext;
use soroban_sdk::{contracttype, Address, BytesN};
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LpSettings {
    pub cash: Address,
    pub asset0: Address,
    pub asset1: Address,
    pub pair: Address,
    pub pair_hash: BytesN<32>,
    pub router: Address,
    pub router_hash: BytesN<32>,
    pub factory: Address,
    pub factory_hash: BytesN<32>,
    pub swap_adapter: Address,
    pub swap_hash: BytesN<32>,
    pub vault_wasm: BytesN<32>,
    pub minimum_entry_bps: u32,
}
