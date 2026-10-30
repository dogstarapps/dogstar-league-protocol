#![no_std]
use soroban_sdk::{contracttype, Address, BytesN};
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultContext {
    pub round: Address,
    pub player: Address,
    pub facility: Address,
    pub adapter: Address,
    pub cash: Address,
    pub basis: i128,
    pub quote_policy: Address,
    pub quote_hash: BytesN<32>,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlendSettings {
    pub cash: Address,
    pub underlying: Address,
    pub pool: Address,
    pub pool_hash: BytesN<32>,
    pub reserve_index: u32,
    pub swap_adapter: Address,
    pub swap_hash: BytesN<32>,
    pub vault_wasm: BytesN<32>,
}
