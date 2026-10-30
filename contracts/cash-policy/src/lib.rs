#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env};
// A cash-only deployment has no tradeable pair. It must never invent a price.
#[contract]
pub struct CashPolicy;
#[contractimpl]
impl CashPolicy {
    pub fn minimum(_e: Env, _sell: Address, _buy: Address, _amount: i128) -> i128 {
        panic!("cash_only_no_trading")
    }
}
