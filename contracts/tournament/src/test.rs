use super::*;
use dogstar_protocol_types::{ExitArtifacts, ExitPolicy, ExitTerms};
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
    pub fn multiplier(e: Env, n: i128) {
        e.storage().instance().set(&1u32, &n);
    }
    pub fn freeze(e: Env) {
        e.storage().instance().set(&0u32, &true);
    }
    pub fn swap(e: Env, _sell: Address, buy: Address, n: i128, _minimum: i128, recipient: Address) {
        assert!(
            !e.storage().instance().get(&0u32).unwrap_or(false),
            "venue_frozen"
        );
        let multiplier: i128 = e.storage().instance().get(&1u32).unwrap_or(1);
        token::Client::new(&e, &buy).transfer(
            &e.current_contract_address(),
            &recipient,
            &(n * multiplier),
        );
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
    setup_with(0, 10000)
}
fn setup_with(premium_bps: u32, coverage: i128) -> Setup {
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
    let other_asset = e.register_stellar_asset_contract_v2(sponsor.clone());
    other_asset
        .issuer()
        .set_flag(soroban_sdk::testutils::IssuerFlags::RevocableFlag);
    let other = other_asset.address();
    let policy = e.register(Policy, ());
    let adapter = e.register(Adapter, ());
    StellarAssetClient::new(&e, &cash).mint(&sponsor, &100000);
    StellarAssetClient::new(&e, &cash).mint(&adapter, &100000);
    StellarAssetClient::new(&e, &other).mint(&adapter, &100000);
    let artifacts = ExitArtifacts {
        facility_wasm: e.deployer().upload_contract_wasm(
            &include_bytes!("../../target/wasm32v1-none/release/dogstar_exit_facility.wasm")[..],
        ),
        spot_receipt_wasm: e.deployer().upload_contract_wasm(
            &include_bytes!("../../target/wasm32v1-none/release/dogstar_spot_receipt.wasm")[..],
        ),
    };
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
        exit: ExitPolicy::Covered(ExitTerms {
            provider: sponsor.clone(),
            fallback_bps: 10000,
            premium_bps,
            minimum_coverage: coverage,
            artifacts,
        }),
    };
    let id = e.register(Tournament, (cfg,));
    fund_coverage(&e, &id, &coverage);
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
#[contractclient(name = "FundingClient")]
#[allow(dead_code)]
trait Funding {
    fn fund(e: Env, n: i128, terms: BytesN<32>);
    fn reserved(e: Env) -> i128;
}
fn fund_coverage(e: &Env, id: &Address, n: &i128) {
    let facility = TournamentClient::new(e, id).exit_facility().unwrap();
    FundingClient::new(e, &facility).fund(n, &TournamentClient::new(e, id).terms());
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
    fund_coverage(&s.e, &id, &10000);
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
    assert_eq!(c.totals().execution, 97);
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
    assert_eq!(c.refund(&3), 98);
    assert_eq!(c.totals().capital, 0);
    assert_eq!(c.totals().execution, 0);
    assert!(c.try_refund(&3).is_err());
}

#[contractclient(name = "ResidualReceiptClient")]
#[allow(dead_code)]
trait ResidualReceipt {
    fn info(e: Env) -> ReceiptInfo;
    fn controller(e: Env) -> Address;
    fn redeem(e: Env) -> i128;
}
#[test]
fn frozen_spot_exit_is_bought_with_reserved_cash_without_player_auth() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    let s = setup();
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    c.swap(&s.p, &s.cash, &s.other, &250, &250, &s.adapter);
    let vault = c.spot_receipt(&s.p, &s.other).unwrap();
    let facility = c.exit_facility().unwrap();
    assert_eq!(FundingClient::new(&s.e, &facility).reserved(), 250);
    AdapterClient::new(&s.e, &s.adapter).freeze();
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    c.advance(&s.op);
    assert!(c
        .try_close_swap(&s.p, &s.other, &250, &s.adapter, &s.op)
        .is_err());
    assert!(c.try_close_buyout(&s.p, &s.other, &s.op).is_err());
    s.e.ledger().with_mut(|l| l.timestamp = 120);
    s.e.mock_auths(&[MockAuth {
        address: &s.op,
        invoke: &MockAuthInvoke {
            contract: &s.id,
            fn_name: "close_buyout",
            args: (s.p.clone(), s.other.clone(), s.op.clone()).into_val(&s.e),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(c.close_buyout(&s.p, &s.other, &s.op), 250);
    assert_eq!(c.balance(&s.p, &s.other), 0);
    assert_eq!(c.balance(&s.p, &s.cash), 1000);
    assert_eq!(
        ResidualReceiptClient::new(&s.e, &vault).controller(),
        s.sponsor
    );
    assert_eq!(FundingClient::new(&s.e, &facility).reserved(), 0);
    s.e.mock_auths(&[]);
    assert!(c.try_withdraw_residual(&vault).is_err());
    s.e.mock_all_auths();
    c.settle_player(&s.p, &s.op);
    c.settle_player(&s.q, &s.op);
    c.finalize(&s.op);
    assert_eq!(c.phase(), 5);
    // The frozen swap venue cannot block redemption of an unfrozen underlying token.
    let before = token::Client::new(&s.e, &s.other).balance(&s.sponsor);
    assert_eq!(ResidualReceiptClient::new(&s.e, &vault).redeem(), 250);
    assert_eq!(
        token::Client::new(&s.e, &s.other).balance(&s.sponsor),
        before + 250
    );
    assert!(ResidualReceiptClient::new(&s.e, &vault)
        .try_redeem()
        .is_err());
}
#[test]
fn reductions_after_cutoff_release_basis_and_native_profit_is_uncapped() {
    let s = setup();
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    c.swap(&s.p, &s.cash, &s.other, &250, &250, &s.adapter);
    let vault = c.spot_receipt(&s.p, &s.other).unwrap();
    s.e.ledger().with_mut(|l| l.timestamp = 95);
    assert!(c
        .try_swap(&s.p, &s.cash, &s.other, &10, &10, &s.adapter)
        .is_err());
    c.swap(&s.p, &s.other, &s.cash, &100, &100, &s.adapter);
    let receipt = ResidualReceiptClient::new(&s.e, &vault).info();
    assert_eq!((receipt.units, receipt.basis), (150, 150));
    assert_eq!(
        FundingClient::new(&s.e, &c.exit_facility().unwrap()).reserved(),
        150
    );
    AdapterClient::new(&s.e, &s.adapter).multiplier(&3);
    c.swap(&s.p, &s.other, &s.cash, &150, &150, &s.adapter);
    assert_eq!(c.balance(&s.p, &s.cash), 1300);
    assert_eq!(
        FundingClient::new(&s.e, &c.exit_facility().unwrap()).reserved(),
        0
    );
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    c.advance(&s.op);
    c.settle_player(&s.p, &s.op);
    assert_eq!(c.player(&s.p).payout, 300);
}
#[test]
fn premiums_are_reserved_with_limits_returned_on_cancel_and_paid_once_on_fill() {
    let s = setup_with(50, 10000);
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    let before = token::Client::new(&s.e, &s.cash).balance(&s.sponsor);
    let id = c.place_limit(&s.p, &s.cash, &s.other, &400, &400, &85);
    assert_eq!(c.balance(&s.p, &s.cash), 598);
    assert_eq!(c.order(&id).premium, 2);
    c.cancel_limit(&id);
    assert_eq!(c.balance(&s.p, &s.cash), 1000);
    assert_eq!(
        token::Client::new(&s.e, &s.cash).balance(&s.sponsor),
        before
    );
    let id = c.place_limit(&s.p, &s.cash, &s.other, &400, &400, &85);
    c.fill_limit(&id, &s.adapter, &s.op);
    assert_eq!(c.balance(&s.p, &s.cash), 598);
    assert_eq!(
        token::Client::new(&s.e, &s.cash).balance(&s.sponsor),
        before + 2
    );
    assert_eq!(c.player_orders(&s.p).len(), 0);
    assert_eq!(c.open_orders().len(), 0);
}
#[test]
fn insufficient_aggregate_coverage_reverts_the_entire_new_trade() {
    let s = setup_with(0, 2000);
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    c.swap(&s.p, &s.cash, &s.other, &400, &400, &s.adapter);
    AdapterClient::new(&s.e, &s.adapter).multiplier(&3);
    c.swap(&s.p, &s.other, &s.cash, &400, &400, &s.adapter);
    AdapterClient::new(&s.e, &s.adapter).multiplier(&1);
    c.swap(&s.q, &s.cash, &s.other, &1000, &1000, &s.adapter);
    assert_eq!(c.balance(&s.p, &s.cash), 1800);
    let before = token::Client::new(&s.e, &s.cash).balance(&s.id);
    assert!(c
        .try_swap(&s.p, &s.cash, &s.other, &1500, &1500, &s.adapter)
        .is_err());
    assert_eq!(c.balance(&s.p, &s.cash), 1800);
    assert_eq!(c.balance(&s.p, &s.other), 0);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.id), before);
    assert_eq!(
        FundingClient::new(&s.e, &c.exit_facility().unwrap()).reserved(),
        1000
    );
}
#[test]
fn public_expiry_is_bounded_pays_once_and_active_orders_do_not_grow_with_history() {
    let s = setup();
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    let one = c.place_limit(&s.p, &s.cash, &s.other, &10, &10, &80);
    let two = c.place_limit(&s.q, &s.cash, &s.other, &10, &10, &80);
    assert_eq!(c.open_orders().len(), 2);
    s.e.ledger().with_mut(|l| l.timestamp = 80);
    let before = token::Client::new(&s.e, &s.cash).balance(&s.op);
    c.expire_limits(&vec![&s.e, one, two], &s.op);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.op), before + 2);
    assert_eq!(c.open_orders().len(), 0);
    assert_eq!(c.totals().fee_reserved, 0);
    assert_eq!(c.balance(&s.p, &s.cash), 1000);
    assert!(c.try_expire_limits(&vec![&s.e, one], &s.op).is_err());
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.op), before + 2);
    for _ in 0..10 {
        c.place_limit(&s.p, &s.cash, &s.other, &1, &1, &85);
    }
    assert!(c
        .try_place_limit(&s.p, &s.cash, &s.other, &1, &1, &85)
        .is_err());
    assert_eq!(c.player_orders(&s.p).len(), 10);
}
#[test]
fn an_unfunded_exit_facility_cancels_before_confirming_participants() {
    let s = setup();
    let configuration = TournamentClient::new(&s.e, &s.id).config();
    let id = s.e.register(Tournament, (configuration,));
    let c = TournamentClient::new(&s.e, &id);
    c.contribute(&s.sponsor, &0, &2000);
    c.contribute(&s.sponsor, &1, &100);
    c.contribute(&s.sponsor, &2, &100);
    c.pre_register(&s.p, &c.terms(), &40);
    c.pre_register(&s.q, &c.terms(), &40);
    s.e.ledger().with_mut(|l| l.timestamp = 30);
    c.advance(&s.op);
    assert_eq!(c.phase(), 6);
    assert_eq!(c.totals().players, 0);
    assert_eq!(c.refund(&1), 2000);
    assert_eq!(c.refund(&2), 100);
    assert_eq!(c.refund(&3), 100);
}
#[test]
fn freezing_the_external_asset_does_not_block_purchase_or_consume_failed_residual_claims() {
    let s = setup();
    active(&s);
    let c = TournamentClient::new(&s.e, &s.id);
    c.swap(&s.p, &s.cash, &s.other, &250, &250, &s.adapter);
    let receipt = c.spot_receipt(&s.p, &s.other).unwrap();
    StellarAssetClient::new(&s.e, &s.other).set_authorized(&s.id, &false);
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    c.advance(&s.op);
    assert!(c
        .try_close_swap(&s.p, &s.other, &250, &s.adapter, &s.op)
        .is_err());
    s.e.ledger().with_mut(|l| l.timestamp = 120);
    assert_eq!(c.close_buyout(&s.p, &s.other, &s.op), 250);
    c.settle_player(&s.p, &s.op);
    c.settle_player(&s.q, &s.op);
    c.finalize(&s.op);
    let residual = ResidualReceiptClient::new(&s.e, &receipt);
    assert!(residual.try_redeem().is_err());
    assert!(!c.residual(&receipt).claimed);
    assert!(residual.info().active);
    StellarAssetClient::new(&s.e, &s.other).set_authorized(&s.id, &true);
    assert_eq!(residual.redeem(), 250);
    assert!(c.residual(&receipt).claimed);
}

#[test]
fn a_contributor_can_refund_a_failed_round_without_waiting_for_a_keeper() {
    let s = setup();
    let c = TournamentClient::new(&s.e, &s.id);
    let id = c.contribute(&s.sponsor, &0, &1000);
    s.e.ledger().with_mut(|l| l.timestamp = 20);
    assert_eq!(c.advance_reward(), 0);
    assert_eq!(c.refund(&id), 1000);
    assert_eq!(c.phase(), 6);
}
