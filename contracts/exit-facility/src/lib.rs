#![no_std]
pub use dogstar_protocol_types::FacilityConfig;
use soroban_sdk::{
    contract, contractclient, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, Executable,
};
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reservation {
    pub amount: i128,
    pub vault_hash: BytesN<32>,
    pub status: u32,
}
#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    Reserved,
    Receipt(Address),
    Lock,
}
#[contractclient(name = "ReceiptClient")]
pub trait Receipt {
    fn controller(e: Env) -> Address;
    fn handover(e: Env, to: Address);
}
#[contractclient(name = "RoundClient")]
pub trait Round {
    fn phase(e: Env) -> u32;
}
#[contractevent]
#[derive(Clone)]
pub struct Purchased {
    #[topic]
    pub vault: Address,
    pub provider: Address,
    pub amount: i128,
}
#[contract]
pub struct ExitFacility;
fn config(e: &Env) -> FacilityConfig {
    e.storage().instance().get(&Key::Config).unwrap()
}
fn enter(e: &Env) {
    assert!(
        !e.storage().instance().get(&Key::Lock).unwrap_or(false),
        "reentrant"
    );
    e.storage().instance().set(&Key::Lock, &true);
}
fn leave(e: &Env) {
    e.storage().instance().set(&Key::Lock, &false);
    let n = e.storage().max_ttl();
    e.storage().instance().extend_ttl(n / 2, n);
}
fn save(e: &Env, vault: &Address, r: &Reservation) {
    let key = Key::Receipt(vault.clone());
    e.storage().persistent().set(&key, r);
    let n = e.storage().max_ttl();
    e.storage().persistent().extend_ttl(&key, n / 2, n);
}
fn hash(address: &Address) -> BytesN<32> {
    match address.executable() {
        Some(Executable::Wasm(h)) => h,
        _ => panic!("receipt_must_be_contract"),
    }
}
#[contractimpl]
impl ExitFacility {
    pub fn __constructor(e: Env, c: FacilityConfig) {
        assert!(
            c.risk_cutoff < c.purchase_at && e.ledger().timestamp() < c.risk_cutoff,
            "invalid_purchase_calendar"
        );
        assert!(
            c.controller != c.provider,
            "provider_must_be_separate_controller"
        );
        e.storage().instance().set(&Key::Config, &c);
        e.storage().instance().set(&Key::Reserved, &0i128);
    }
    pub fn config(e: Env) -> FacilityConfig {
        config(&e)
    }
    pub fn reserved(e: Env) -> i128 {
        e.storage().instance().get(&Key::Reserved).unwrap()
    }
    pub fn available(e: Env) -> i128 {
        let c = config(&e);
        token::Client::new(&e, &c.cash).balance(&e.current_contract_address()) - Self::reserved(e)
    }
    pub fn reservation(e: Env, vault: Address) -> Reservation {
        e.storage().persistent().get(&Key::Receipt(vault)).unwrap()
    }
    pub fn fund(e: Env, n: i128, terms: BytesN<32>) {
        let c = config(&e);
        c.provider.require_auth();
        enter(&e);
        assert!(terms == c.round_terms, "round_terms_mismatch");
        assert!(n > 0, "positive_funding_required");
        let token = token::Client::new(&e, &c.cash);
        let me = e.current_contract_address();
        let before = token.balance(&me);
        token.transfer(&c.provider, &me, &n);
        assert!(token.balance(&me) - before == n, "funding_delta");
        leave(&e);
    }
    pub fn reserve(e: Env, vault: Address, n: i128) {
        let c = config(&e);
        c.controller.require_auth();
        enter(&e);
        assert!(
            e.ledger().timestamp() < c.risk_cutoff && n >= 0,
            "reservation_window"
        );
        assert!(
            !e.storage().persistent().has(&Key::Receipt(vault.clone())),
            "receipt_already_reserved"
        );
        assert!(
            Self::available(e.clone()) >= n,
            "insufficient_unencumbered_cash"
        );
        assert!(
            ReceiptClient::new(&e, &vault).controller() == c.controller,
            "receipt_controller_mismatch"
        );
        let r = Reservation {
            amount: n,
            vault_hash: hash(&vault),
            status: 0,
        };
        save(&e, &vault, &r);
        e.storage()
            .instance()
            .set(&Key::Reserved, &(Self::reserved(e.clone()) + n));
        leave(&e);
    }
    pub fn adjust(e: Env, vault: Address, n: i128) {
        let c = config(&e);
        c.controller.require_auth();
        enter(&e);
        let mut r = Self::reservation(e.clone(), vault.clone());
        assert!(
            n >= 0 && r.status == 0 && hash(&vault) == r.vault_hash,
            "invalid_adjustment"
        );
        assert!(
            ReceiptClient::new(&e, &vault).controller() == c.controller,
            "receipt_controller_mismatch"
        );
        let difference = n - r.amount;
        if difference > 0 {
            assert!(e.ledger().timestamp() < c.risk_cutoff, "reservation_window");
            assert!(
                Self::available(e.clone()) >= difference,
                "insufficient_unencumbered_cash"
            );
        }
        r.amount = n;
        save(&e, &vault, &r);
        e.storage()
            .instance()
            .set(&Key::Reserved, &(Self::reserved(e.clone()) + difference));
        leave(&e);
    }
    pub fn release(e: Env, vault: Address) {
        let c = config(&e);
        c.controller.require_auth();
        enter(&e);
        let mut r = Self::reservation(e.clone(), vault.clone());
        assert!(r.status == 0, "receipt_consumed");
        r.status = 1;
        save(&e, &vault, &r);
        e.storage()
            .instance()
            .set(&Key::Reserved, &(Self::reserved(e.clone()) - r.amount));
        leave(&e);
    }
    pub fn purchase(e: Env, vault: Address) -> i128 {
        let c = config(&e);
        c.controller.require_auth();
        enter(&e);
        assert!(e.ledger().timestamp() >= c.purchase_at, "purchase_not_due");
        let mut r = Self::reservation(e.clone(), vault.clone());
        assert!(
            r.status == 0 && hash(&vault) == r.vault_hash,
            "receipt_consumed_or_changed"
        );
        assert!(
            ReceiptClient::new(&e, &vault).controller() == c.controller,
            "receipt_controller_mismatch"
        );
        // This calls only the immutable receipt's local ownership method, never the external venue.
        ReceiptClient::new(&e, &vault).handover(&c.provider);
        r.status = 2;
        save(&e, &vault, &r);
        e.storage()
            .instance()
            .set(&Key::Reserved, &(Self::reserved(e.clone()) - r.amount));
        if r.amount > 0 {
            token::Client::new(&e, &c.cash).transfer(
                &e.current_contract_address(),
                &c.controller,
                &r.amount,
            );
        }
        Purchased {
            vault,
            provider: c.provider,
            amount: r.amount,
        }
        .publish(&e);
        leave(&e);
        r.amount
    }
    pub fn withdraw_free(e: Env, n: i128) {
        let c = config(&e);
        c.provider.require_auth();
        enter(&e);
        assert!(
            e.ledger().timestamp() >= c.risk_cutoff
                || RoundClient::new(&e, &c.controller).phase() == 6,
            "capacity_locked_until_cutoff"
        );
        assert!(
            n > 0 && n <= Self::available(e.clone()),
            "reserved_cash_cannot_be_withdrawn"
        );
        token::Client::new(&e, &c.cash).transfer(&e.current_contract_address(), &c.provider, &n);
        leave(&e);
    }
    pub fn keepalive(e: Env, vault: Option<Address>) {
        let n = e.storage().max_ttl();
        e.storage().instance().extend_ttl(n / 2, n);
        if let Some(vault) = vault {
            e.storage()
                .persistent()
                .extend_ttl(&Key::Receipt(vault), n / 2, n);
        }
    }
}

#[cfg(test)]
mod test;
