use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    vec,
};
#[contract]
struct Policy;
#[contractimpl]
impl Policy {
    pub fn minimum(_e: Env, _sell: Address, _buy: Address, n: i128) -> i128 {
        n * 99 / 100
    }
}
#[contract]
struct Adapter;
#[contractimpl]
impl Adapter {
    pub fn swap(e: Env, _sell: Address, buy: Address, n: i128, _minimum: i128, recipient: Address) {
        token::Client::new(&e, &buy).transfer(&e.current_contract_address(), &recipient, &n);
    }
}
struct Setup {
    e: Env,
    id: Address,
    cash: Address,
    other: Address,
    sponsor: Address,
    p: Address,
    q: Address,
    op: Address,
    adapter: Address,
}
fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().with_mut(|l| l.timestamp = 10);
    let sponsor = Address::generate(&e);
    let p = Address::generate(&e);
    let q = Address::generate(&e);
    let op = Address::generate(&e);
    let cash = e
        .register_stellar_asset_contract_v2(sponsor.clone())
        .address();
    let other = e
        .register_stellar_asset_contract_v2(sponsor.clone())
        .address();
    let policy = e.register(Policy, ());
    let adapter = e.register(Adapter, ());
    StellarAssetClient::new(&e, &cash).mint(&sponsor, &100000);
    StellarAssetClient::new(&e, &cash).mint(&adapter, &100000);
    StellarAssetClient::new(&e, &other).mint(&adapter, &100000);
    let cfg = Config {
        creator: sponsor.clone(),
        cash: cash.clone(),
        assets: vec![&e, cash.clone(), other.clone()],
        adapters: vec![&e, adapter.clone()],
        quote_policy: policy,
        calendar: Calendar {
            funding_open: 1,
            funding_close: 20,
            registration_open: 1,
            registration_close: 30,
            prepare_by: 40,
            start: 50,
            risk_cutoff: 90,
            end: 100,
            settle_by: 120,
        },
        capital: 1000,
        min_players: 2,
        max_players: 2,
        share_bps: 10000,
        prizes: 100,
        execution: 100,
        reward: 1,
    };
    let id = e.register(Tournament, (cfg,));
    Setup {
        e,
        id,
        cash,
        other,
        sponsor,
        p,
        q,
        op,
        adapter,
    }
}
fn funded(s: &Setup) {
    let c = TournamentClient::new(&s.e, &s.id);
    c.contribute(&s.sponsor, &0, &2000);
    c.contribute(&s.sponsor, &1, &100);
    c.contribute(&s.sponsor, &2, &100);
    for p in [&s.p, &s.q] {
        c.pre_register(p, &c.terms(), &40);
    }
}
fn active(s: &Setup) {
    funded(s);
    let c = TournamentClient::new(&s.e, &s.id);
    s.e.ledger().with_mut(|l| l.timestamp = 30);
    c.advance(&s.op);
    s.e.ledger().with_mut(|l| l.timestamp = 50);
    c.advance(&s.op);
}
#[test]
fn custody_calendar_and_public_close() {
    let s = setup();
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    assert_eq!(c.balance(&s.p, &s.cash), 1000);
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    assert!(c
        .try_swap(&s.p, &s.cash, &s.other, &10, &10, &s.adapter)
        .is_err());
    c.advance(&s.op);
    c.settle_player(&s.p, &s.op);
    c.settle_player(&s.q, &s.op);
    c.finalize(&s.op);
    assert_eq!(c.phase(), 5);
    let winner = c.totals().prize_winner.unwrap();
    c.claim(&winner);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&winner), 100);
    assert!(c.try_claim(&winner).is_err());
    assert_eq!(c.sponsor_claim(&1), 2000);
    assert!(c.try_sponsor_claim(&1).is_err());
}
#[test]
fn limits_reserve_once_and_expire_independently_of_keeper() {
    let s = setup();
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    let id = c.place_limit(&s.p, &s.cash, &s.other, &400, &400, &85);
    assert_eq!(c.balance(&s.p, &s.cash), 600);
    assert!(c
        .try_place_limit(&s.p, &s.cash, &s.other, &700, &700, &85)
        .is_err());
    c.fill_limit(&id, &s.adapter, &s.op);
    assert_eq!(c.balance(&s.p, &s.other), 400);
    assert!(c.try_fill_limit(&id, &s.adapter, &s.op).is_err());
    let expiry = c.place_limit(&s.q, &s.cash, &s.other, &200, &200, &85);
    s.e.ledger().with_mut(|l| l.timestamp = 90);
    assert!(c.try_fill_limit(&expiry, &s.adapter, &s.op).is_err());
    c.cancel_limit(&expiry);
    assert_eq!(c.balance(&s.q, &s.cash), 1000);
}
#[test]
fn unauthorized_user_action_records_auth_and_keeper_close_does_not_need_player() {
    let s = setup();
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    c.place_limit(&s.p, &s.cash, &s.other, &100, &100, &80);
    assert_eq!(s.e.auths()[0].0, s.p);
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    c.advance(&s.op);
    c.cancel_limit(&1);
    c.settle_player(&s.p, &s.op);
    assert_eq!(s.e.auths()[0].0, s.op);
}
#[test]
fn insufficient_funding_refunds_only_original_owner() {
    let s = setup();
    let c = TournamentClient::new(&s.e, &s.id);
    let id = c.contribute(&s.sponsor, &0, &1000);
    s.e.ledger().with_mut(|l| l.timestamp = 20);
    c.advance(&s.op);
    assert_eq!(c.phase(), 6);
    let before = token::Client::new(&s.e, &s.cash).balance(&s.sponsor);
    c.refund(&id);
    assert_eq!(
        token::Client::new(&s.e, &s.cash).balance(&s.sponsor),
        before + 1000
    );
    assert!(c.try_refund(&id).is_err());
}
#[test]
fn actual_token_deltas_drive_profit_not_adapter_return_values() {
    let s = setup();
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    assert_eq!(c.swap(&s.p, &s.cash, &s.other, &250, &250, &s.adapter), 250);
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    c.advance(&s.op);
    c.close_swap(&s.p, &s.other, &250, &s.adapter, &s.op);
    c.settle_player(&s.p, &s.op);
    assert_eq!(c.player(&s.p).recovery, 1000);
}
#[test]
fn wrong_terms_and_late_preparation_cannot_start() {
    let s = setup();
    let c = TournamentClient::new(&s.e, &s.id);
    assert!(c
        .try_pre_register(&s.p, &BytesN::from_array(&s.e, &[0; 32]), &40)
        .is_err());
    funded(&s);
    s.e.ledger().with_mut(|l| l.timestamp = 41);
    c.advance(&s.op);
    assert_eq!(c.phase(), 6);
}
#[test]
fn a_user_cannot_place_orders_without_authorization() {
    let s = setup();
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    s.e.set_auths(&[]);
    assert!(c
        .try_place_limit(&s.p, &s.cash, &s.other, &100, &100, &80)
        .is_err());
}
#[test]
fn withdrawing_a_registration_frees_capacity() {
    let s = setup();
    funded(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    c.leave(&s.p);
    let replacement = Address::generate(&s.e);
    c.pre_register(&replacement, &c.terms(), &40);
    assert_eq!(c.registrations().len(), 2);
}

#[test]
fn an_adapter_upgrade_cannot_change_an_existing_rounds_accepted_code() {
    let s = setup();
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    let accepted = c.adapter_hash(&s.adapter);
    let replacement = s.e.deployer().upload_contract_wasm(
        &include_bytes!("../../target/wasm32v1-none/release/dogstar_registry.wasm")[..],
    );
    s.e.as_contract(&s.adapter, || {
        s.e.deployer()
            .update_current_contract_wasm(replacement.clone())
    });
    assert_ne!(accepted, replacement);
    assert_eq!(c.adapter_hash(&s.adapter), accepted);
    assert!(c
        .try_swap(&s.p, &s.cash, &s.other, &250, &250, &s.adapter)
        .is_err());
    assert_eq!(c.balance(&s.p, &s.cash), 1000);
}

fn larger_round(s: &Setup) -> (Address, Vec<Address>) {
    let mut c = TournamentClient::new(&s.e, &s.id).config();
    c.min_players = 6;
    c.max_players = 6;
    let id = s.e.register(Tournament, (c,));
    let client = TournamentClient::new(&s.e, &id);
    client.contribute(&s.sponsor, &0, &6000);
    client.contribute(&s.sponsor, &1, &100);
    client.contribute(&s.sponsor, &2, &100);
    let mut players = Vec::new(&s.e);
    for _ in 0..6 {
        let p = Address::generate(&s.e);
        client.pre_register(&p, &client.terms(), &40);
        players.push_back(p);
    }
    (id, players)
}
#[test]
fn preparation_is_batched_and_allocates_each_seat_once() {
    let s = setup();
    let (id, players) = larger_round(&s);
    let c = TournamentClient::new(&s.e, &id);
    s.e.ledger().with_mut(|l| l.timestamp = 30);
    c.advance(&s.op);
    assert_eq!(c.phase(), 1);
    assert_eq!(c.totals().players, 5);
    assert_eq!(c.totals().capital, 6000);
    c.advance(&s.op);
    assert_eq!(c.phase(), 2);
    assert_eq!(c.totals().players, 6);
    assert_eq!(c.totals().capital, 0);
    assert_eq!(c.totals().execution, 98);
    assert!(c.try_advance(&s.op).is_err());
    for p in players.iter() {
        assert_eq!(c.balance(&p, &s.cash), 1000);
    }
}
#[test]
fn cancelled_partial_preparation_preserves_principal_and_refunds_unused_execution() {
    let s = setup();
    let (id, _) = larger_round(&s);
    let c = TournamentClient::new(&s.e, &id);
    s.e.ledger().with_mut(|l| l.timestamp = 30);
    c.advance(&s.op);
    s.e.ledger().with_mut(|l| l.timestamp = 41);
    c.advance(&s.op);
    assert_eq!(c.phase(), 6);
    assert_eq!(c.refund(&1), 6000);
    assert_eq!(c.refund(&2), 100);
    assert_eq!(c.refund(&3), 99);
    assert_eq!(c.totals().capital, 0);
    assert_eq!(c.totals().execution, 0);
    assert!(c.try_refund(&3).is_err());
}
