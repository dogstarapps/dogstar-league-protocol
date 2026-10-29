#![no_std]
pub use dogstar_protocol_types::ReceiptInfo;
use soroban_sdk::{contract, contractclient, contractimpl, contracttype, Address, Env};
#[contracttype]
#[derive(Clone)]
enum Key {
    Info,
}
#[contractclient(name = "RoundClient")]
pub trait Round {
    fn withdraw_residual(e: Env, vault: Address) -> i128;
}
#[contract]
pub struct SpotReceipt;
fn info(e: &Env) -> ReceiptInfo {
    e.storage().instance().get(&Key::Info).unwrap()
}
fn save(e: &Env, r: &ReceiptInfo) {
    e.storage().instance().set(&Key::Info, r);
    let n = e.storage().max_ttl();
    e.storage().instance().extend_ttl(n / 2, n);
}
#[contractimpl]
impl SpotReceipt {
    pub fn __constructor(e: Env, r: ReceiptInfo) {
        assert!(
            r.controller == r.round && r.units > 0 && r.basis >= 0 && r.active,
            "invalid_receipt"
        );
        save(&e, &r);
    }
    pub fn info(e: Env) -> ReceiptInfo {
        info(&e)
    }
    pub fn controller(e: Env) -> Address {
        info(&e).controller
    }
    pub fn keepalive(e: Env) {
        let n = e.storage().max_ttl();
        e.storage().instance().extend_ttl(n / 2, n);
    }
    pub fn update(e: Env, units: i128, basis: i128) {
        let mut r = info(&e);
        r.round.require_auth();
        assert!(
            r.controller == r.round && r.active && units >= 0 && basis >= 0,
            "receipt_transferred_or_closed"
        );
        r.units = units;
        r.basis = basis;
        r.active = units > 0;
        save(&e, &r);
    }
    pub fn handover(e: Env, to: Address) {
        let mut r = info(&e);
        r.facility.require_auth();
        assert!(
            r.active && r.controller == r.round && to != r.round,
            "receipt_transferred_or_closed"
        );
        r.controller = to;
        save(&e, &r);
    }
    pub fn redeem(e: Env) -> i128 {
        let mut r = info(&e);
        r.controller.require_auth();
        assert!(r.controller != r.round && r.active, "residual_not_owned");
        let amount =
            RoundClient::new(&e, &r.round).withdraw_residual(&e.current_contract_address());
        r.active = false;
        save(&e, &r);
        amount
    }
}
