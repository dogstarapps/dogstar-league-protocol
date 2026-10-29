use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
};
#[contract]
struct Controller;
#[contractimpl]
impl Controller {
    pub fn phase() -> u32 {
        4
    }
    pub fn reserve(e: Env, facility: Address, vault: Address, n: i128) {
        ExitFacilityClient::new(&e, &facility).reserve(&vault, &n);
    }
    pub fn buy(e: Env, facility: Address, vault: Address) -> i128 {
        ExitFacilityClient::new(&e, &facility).purchase(&vault)
    }
    pub fn adjust(e: Env, facility: Address, vault: Address, n: i128) {
        ExitFacilityClient::new(&e, &facility).adjust(&vault, &n);
    }
}
#[contract]
struct Vault;
#[contractimpl]
impl Vault {
    pub fn __constructor(e: Env, owner: Address, facility: Address) {
        e.storage().instance().set(&0u32, &owner);
        e.storage().instance().set(&1u32, &facility);
    }
    pub fn controller(e: Env) -> Address {
        e.storage().instance().get(&0u32).unwrap()
    }
    pub fn handover(e: Env, to: Address) {
        let f: Address = e.storage().instance().get(&1u32).unwrap();
        f.require_auth();
        e.storage().instance().set(&0u32, &to);
    }
    pub fn native_exit() {
        panic!("external_venue_frozen")
    }
}
struct Setup {
    e: Env,
    cash: Address,
    controller: Address,
    provider: Address,
    facility: Address,
    vault: Address,
}
fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().with_mut(|l| l.timestamp = 10);
    let provider = Address::generate(&e);
    let admin = Address::generate(&e);
    let cash = e.register_stellar_asset_contract_v2(admin).address();
    StellarAssetClient::new(&e, &cash).mint(&provider, &1000);
    let controller = e.register(Controller, ());
    let c = FacilityConfig {
        cash: cash.clone(),
        controller: controller.clone(),
        provider: provider.clone(),
        risk_cutoff: 80,
        purchase_at: 100,
        round_terms: BytesN::from_array(&e, &[6; 32]),
    };
    let facility = e.register(ExitFacility, (c,));
    let vault = e.register(Vault, (controller.clone(), facility.clone()));
    ExitFacilityClient::new(&e, &facility).fund(&1000, &BytesN::from_array(&e, &[6; 32]));
    e.mock_auths(&[]);
    Setup {
        e,
        cash,
        controller,
        provider,
        facility,
        vault,
    }
}
#[test]
fn frozen_native_exit_does_not_block_cash_purchase_and_residual_handover() {
    let s = setup();
    let f = ExitFacilityClient::new(&s.e, &s.facility);
    let c = ControllerClient::new(&s.e, &s.controller);
    let v = VaultClient::new(&s.e, &s.vault);
    c.reserve(&s.facility, &s.vault, &600);
    assert_eq!(f.available(), 400);
    assert!(v.try_native_exit().is_err());
    assert!(c.try_buy(&s.facility, &s.vault).is_err());
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    assert_eq!(c.buy(&s.facility, &s.vault), 600);
    assert_eq!(v.controller(), s.provider);
    assert_eq!(
        token::Client::new(&s.e, &s.cash).balance(&s.controller),
        600
    );
    assert_eq!(f.reserved(), 0);
    assert!(c.try_buy(&s.facility, &s.vault).is_err());
}
#[test]
fn obligations_cannot_double_spend_cash_or_be_called_outside_the_round() {
    let s = setup();
    let f = ExitFacilityClient::new(&s.e, &s.facility);
    let c = ControllerClient::new(&s.e, &s.controller);
    assert!(f.try_reserve(&s.vault, &600).is_err());
    c.reserve(&s.facility, &s.vault, &600);
    let second =
        s.e.register(Vault, (s.controller.clone(), s.facility.clone()));
    assert!(c.try_reserve(&s.facility, &second, &500).is_err());
    assert_eq!(f.reserved(), 600);
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    assert!(f.try_purchase(&s.vault).is_err());
    assert_eq!(f.reserved(), 600);
}
#[test]
fn provider_can_only_withdraw_unencumbered_cash_after_cutoff() {
    let s = setup();
    let f = ExitFacilityClient::new(&s.e, &s.facility);
    ControllerClient::new(&s.e, &s.controller).reserve(&s.facility, &s.vault, &600);
    s.e.mock_all_auths();
    assert!(f.try_withdraw_free(&1).is_err());
    s.e.ledger().with_mut(|l| l.timestamp = 80);
    assert!(f.try_withdraw_free(&401).is_err());
    f.withdraw_free(&400);
    assert_eq!(f.available(), 0);
    assert_eq!(f.reserved(), 600);
}
#[test]
fn decreasing_a_reservation_after_cutoff_cannot_reopen_risk() {
    let s = setup();
    let c = ControllerClient::new(&s.e, &s.controller);
    let f = ExitFacilityClient::new(&s.e, &s.facility);
    c.reserve(&s.facility, &s.vault, &600);
    s.e.ledger().with_mut(|l| l.timestamp = 80);
    c.adjust(&s.facility, &s.vault, &200);
    assert_eq!(f.reserved(), 200);
    assert!(c.try_adjust(&s.facility, &s.vault, &201).is_err());
    s.e.mock_all_auths();
    f.withdraw_free(&800);
    assert_eq!(f.available(), 0);
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    assert_eq!(c.buy(&s.facility, &s.vault), 200);
}
#[test]
fn provider_funding_requires_consent_to_exact_round_terms() {
    let s = setup();
    s.e.mock_all_auths();
    let f = ExitFacilityClient::new(&s.e, &s.facility);
    StellarAssetClient::new(&s.e, &s.cash).mint(&s.provider, &100);
    assert!(f
        .try_fund(&100, &BytesN::from_array(&s.e, &[7; 32]))
        .is_err());
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.provider), 100);
    f.fund(&100, &BytesN::from_array(&s.e, &[6; 32]));
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.provider), 0);
}
#[test]
fn unsolicited_transfers_do_not_create_provider_commitments_or_extra_capacity() {
    let s = setup();
    s.e.mock_all_auths();
    let f = ExitFacilityClient::new(&s.e, &s.facility);
    let donor = Address::generate(&s.e);
    StellarAssetClient::new(&s.e, &s.cash).mint(&donor, &100);
    token::Client::new(&s.e, &s.cash).transfer(&donor, &s.facility, &100);
    assert_eq!(f.committed(), 1000);
    assert_eq!(f.available(), 1000);
    ControllerClient::new(&s.e, &s.controller).reserve(&s.facility, &s.vault, &600);
    assert_eq!(f.available(), 400);
    s.e.ledger().with_mut(|l| l.timestamp = 80);
    f.withdraw_free(&400);
    assert_eq!(f.committed(), 600);
    assert_eq!(f.available(), 0);
    assert!(f.try_withdraw_free(&1).is_err());
    assert_eq!(f.withdraw_surplus(), 100);
    assert_eq!(f.committed(), 600);
    assert_eq!(f.reserved(), 600);
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    assert_eq!(
        ControllerClient::new(&s.e, &s.controller).buy(&s.facility, &s.vault),
        600
    );
    assert_eq!(f.committed(), 0);
    assert_eq!(f.reserved(), 0);
}
