#![no_std]
pub use dogstar_vault_types::VaultContext;
use soroban_sdk::{contractclient, contracttype, Address, Bytes, BytesN, Env, Map, Symbol, Val};
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ZenexSettings {
    pub cash: Address,
    pub settlement: Address,
    pub market: Address,
    pub market_hash: BytesN<32>,
    pub swap_adapter: Address,
    pub swap_hash: BytesN<32>,
    pub vault_wasm: BytesN<32>,
    pub max_leverage_bps: u32,
    pub close_fee_reserve: i128,
}
// Required venue-owned extension. This interface is NOT present in the inspected
// Zenex market 02aa342f... . No external certifier may populate these values.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraderState {
    pub version: u32,
    pub epoch: BytesN<32>,
    pub sequence: u64,
    pub paid: i128,
    pub credit: i128,
    pub long_notional: i128,
    pub short_notional: i128,
    pub pending_orders: u32,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenRequest {
    pub is_long: bool,
    pub notional: i128,
    pub price_bound: i128,
    pub price: Bytes,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloseRequest {
    pub price_bound: i128,
    pub price: Bytes,
}
#[contractclient(name = "MarketClient")]
pub trait Market {
    fn get_token(e: Env) -> Address;
    fn get_treasury(e: Env) -> Address;
    fn get_config(e: Env) -> Map<Symbol, Val>;
    fn get_trader_state(e: Env, user: Address) -> TraderState;
    fn create_order(
        e: Env,
        user: Address,
        is_long: bool,
        kind: u32,
        notional: i128,
        margin: i128,
        trigger_price: i128,
        price_bound: i128,
        expiration: u32,
    ) -> u32;
    fn execute_order(e: Env, keeper: Address, user: Address, id: u32, price: Bytes) -> i128;
    fn claim_credit(e: Env, user: Address) -> i128;
}
