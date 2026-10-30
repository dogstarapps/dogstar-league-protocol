use super::*;
use dogstar_protocol_types::{AccessRule, ExitArtifacts, ExitPolicy, ExitTerms, RoundAccess};
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
    pub fn capabilities() -> u32 {
        1
    }
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
    setup_access(premium_bps, coverage, 0)
}
fn setup_access(premium_bps: u32, coverage: i128, mode: u32) -> Setup {
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
        access: if mode == 0 {
            RoundAccess::open()
        } else {
            RoundAccess {
                funding: if mode == 1 {
                    AccessRule::CreatorOnly
                } else {
                    AccessRule::Allowlist(vec![&e, sponsor.clone()])
                },
                participation: AccessRule::Allowlist(vec![&e, p.clone(), q.clone()]),
            }
        },
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

#[contract]
struct SupplyPool;
#[contractimpl]
impl SupplyPool {
    pub fn __constructor(e: Env, asset: Address) {
        e.storage().instance().set(&0u32, &asset);
        e.storage().instance().set(&1u32, &2i128);
    }
    pub fn rate(e: Env, n: i128) {
        e.storage().instance().set(&1u32, &n);
    }
    pub fn freeze(e: Env, frozen: bool) {
        e.storage().instance().set(&2u32, &frozen);
    }
    pub fn get_positions(
        e: Env,
        address: Address,
    ) -> dogstar_external_interfaces::blend::Positions {
        let shares: i128 = e.storage().persistent().get(&address).unwrap_or(0);
        let mut supply = Map::new(&e);
        if shares > 0 {
            supply.set(0u32, shares);
        }
        dogstar_external_interfaces::blend::Positions {
            collateral: Map::new(&e),
            liabilities: Map::new(&e),
            supply,
        }
    }
    pub fn submit(
        e: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<dogstar_external_interfaces::blend::Request>,
    ) -> dogstar_external_interfaces::blend::Positions {
        from.require_auth();
        spender.require_auth();
        to.require_auth();
        assert!(
            !e.storage().instance().get(&2u32).unwrap_or(false),
            "pool_frozen"
        );
        let asset: Address = e.storage().instance().get(&0u32).unwrap();
        let rate: i128 = e.storage().instance().get(&1u32).unwrap();
        for request in requests.iter() {
            assert!(request.address == asset, "wrong_asset");
            if request.request_type == 0 {
                token::Client::new(&e, &asset).transfer(
                    &spender,
                    &e.current_contract_address(),
                    &request.amount,
                );
                e.storage()
                    .persistent()
                    .set(&from, &(request.amount / rate));
            } else {
                assert!(
                    request.request_type == 1 && request.amount == i128::MAX,
                    "full_supply_exit_only"
                );
                let shares: i128 = e.storage().persistent().get(&from).unwrap();
                token::Client::new(&e, &asset).transfer(
                    &e.current_contract_address(),
                    &to,
                    &(shares * rate),
                );
                e.storage().persistent().set(&from, &0i128);
            }
        }
        Self::get_positions(e, from)
    }
}
fn with_supply(coverage: i128) -> (Setup, Address, Address) {
    let mut s = setup();
    let mut config = TournamentClient::new(&s.e, &s.id).config();
    if let dogstar_protocol_types::ExitPolicy::Covered(ref mut exit) = config.exit {
        exit.minimum_coverage = coverage;
    }
    let pool = s.e.register(SupplyPool, (s.cash.clone(),));
    StellarAssetClient::new(&s.e, &s.cash).mint(&pool, &100000);
    let settings = dogstar_vault_types::BlendSettings {
        cash: s.cash.clone(),
        underlying: s.cash.clone(),
        pool: pool.clone(),
        pool_hash: wasm_hash(&s.e, &pool),
        reserve_index: 0,
        swap_adapter: s.adapter.clone(),
        swap_hash: wasm_hash(&s.e, &s.adapter),
        vault_wasm: s.e.deployer().upload_contract_wasm(
            &include_bytes!("../../target/wasm32v1-none/release/dogstar_blend_vault.wasm")[..],
        ),
    };
    let adapter = s.e.register(
        &include_bytes!("../../target/wasm32v1-none/release/dogstar_blend_adapter.wasm")[..],
        (settings,),
    );
    config.adapters.push_back(adapter.clone());
    let id = s.e.register(Tournament, (config,));
    fund_coverage(&s.e, &id, &coverage);
    s.id = id;
    active(&s);
    (s, pool, adapter)
}
#[test]
fn managed_supply_positions_account_real_cash_yield_and_reserve_closing_rewards() {
    let (s, pool, adapter) = with_supply(10000);
    let c = TournamentClient::new(&s.e, &s.id);
    let id = c.open_position(&s.p, &adapter, &1000, &vec![&s.e, 1000], &Bytes::new(&s.e));
    assert_eq!(c.positions(&s.p).len(), 1);
    assert_eq!(c.balance(&s.p, &s.cash), 0);
    assert_eq!(c.totals().fee_reserved, 1);
    SupplyPoolClient::new(&s.e, &pool).rate(&3);
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    c.advance(&s.op);
    assert!(c.try_settle_player(&s.p, &s.op).is_err());
    assert_eq!(c.close_position(&id, &1000, &Bytes::new(&s.e), &s.op), 1500);
    assert_eq!(c.totals().fee_reserved, 0);
    assert_eq!(c.positions(&s.p).len(), 0);
    c.settle_player(&s.p, &s.op);
    assert_eq!(c.player(&s.p).payout, 500);
    assert_eq!(c.owner_position_count(&s.p), 1);
    assert_eq!(
        c.owner_positions_page(&s.p, &0, &20).get(0).unwrap().owner,
        s.p
    );
    assert_eq!(c.position_count(), 1);
    let history = c.positions_page(&0, &20);
    assert_eq!(history.len(), 1);
    assert!(!history.get(0).unwrap().open);
    assert_eq!(history.get(0).unwrap().vault, c.position(&id).vault);
    assert!(c.try_positions_page(&0, &21).is_err());
}
#[test]
fn owned_position_history_crosses_page_boundaries_without_mixing_owners() {
    let (s, _pool, adapter) = with_supply(10000);
    let c = TournamentClient::new(&s.e, &s.id);
    for _ in 0..21 {
        s.e.budget().reset_default();
        let id = c.open_position(&s.p, &adapter, &10, &vec![&s.e, 10], &Bytes::new(&s.e));
        assert_eq!(c.exit_position(&s.p, &id, &10, &Bytes::new(&s.e)), 10);
    }
    s.e.budget().reset_default();
    assert_eq!(c.owner_position_count(&s.p), 21);
    assert_eq!(c.owner_positions_page(&s.p, &0, &20).len(), 20);
    let page = c.owner_positions_page(&s.p, &19, &20);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap().id, 20);
    assert_eq!(page.get(1).unwrap().id, 21);
    assert_eq!(page.get(1).unwrap().owner_offset, 20);
    assert_eq!(c.owner_position_count(&s.q), 0);
    assert_eq!(c.owner_positions_page(&s.q, &0, &20).len(), 0);
    assert_eq!(c.owner_positions_page(&s.p, &21, &20).len(), 0);
    assert!(c.try_owner_positions_page(&s.p, &0, &21).is_err());
}
#[test]
fn frozen_managed_positions_settle_via_reserved_purchase_without_player_signature() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    let (s, pool, adapter) = with_supply(10000);
    let c = TournamentClient::new(&s.e, &s.id);
    let id = c.open_position(&s.p, &adapter, &800, &vec![&s.e, 800], &Bytes::new(&s.e));
    SupplyPoolClient::new(&s.e, &pool).freeze(&true);
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    c.advance(&s.op);
    assert!(c
        .try_close_position(&id, &0, &Bytes::new(&s.e), &s.op)
        .is_err());
    assert!(c.try_buyout_position(&id, &s.op).is_err());
    s.e.ledger().with_mut(|l| l.timestamp = 120);
    s.e.mock_auths(&[MockAuth {
        address: &s.op,
        invoke: &MockAuthInvoke {
            contract: &s.id,
            fn_name: "buyout_position",
            args: (id, s.op.clone()).into_val(&s.e),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(c.buyout_position(&id, &s.op), 800);
    assert_eq!(c.balance(&s.p, &s.cash), 1000);
    assert_eq!(c.positions(&s.p).len(), 0);
    let info = ManagedVaultClient::new(&s.e, &c.position(&id).vault).info();
    assert_eq!(info.controller, s.sponsor);
    assert_eq!(c.owner_position_count(&s.sponsor), 1);
    assert_eq!(
        c.owner_positions_page(&s.sponsor, &0, &20)
            .get(0)
            .unwrap()
            .vault,
        c.position(&id).vault
    );
    s.e.mock_all_auths();
    c.settle_player(&s.p, &s.op);
    c.settle_player(&s.q, &s.op);
    c.finalize(&s.op);
    assert_eq!(c.phase(), 5);
}
#[test]
fn insufficient_managed_coverage_reverts_deployment_pool_supply_and_cash_debit() {
    let (s, pool, adapter) = with_supply(2000);
    let c = TournamentClient::new(&s.e, &s.id);
    let id = c.open_position(&s.p, &adapter, &1000, &vec![&s.e, 1000], &Bytes::new(&s.e));
    SupplyPoolClient::new(&s.e, &pool).rate(&3);
    assert_eq!(c.exit_position(&s.p, &id, &0, &Bytes::new(&s.e)), 1500);
    c.open_position(&s.q, &adapter, &1000, &vec![&s.e, 1000], &Bytes::new(&s.e));
    let before = token::Client::new(&s.e, &s.cash).balance(&s.id);
    assert!(c
        .try_open_position(&s.p, &adapter, &1500, &vec![&s.e, 1500], &Bytes::new(&s.e))
        .is_err());
    assert_eq!(c.balance(&s.p, &s.cash), 1500);
    assert_eq!(c.positions(&s.p).len(), 0);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.id), before);
}

#[test]
fn permissionless_player_maintenance_renews_positions_vaults_and_coverage_together() {
    use soroban_sdk::testutils::storage::{Instance, Persistent};
    let (s, _pool, adapter) = with_supply(10000);
    let c = TournamentClient::new(&s.e, &s.id);
    let id = c.open_position(&s.p, &adapter, &800, &vec![&s.e, 800], &Bytes::new(&s.e));
    let vault = c.position(&id).vault;
    let facility = c.exit_facility().unwrap();
    s.e.ledger().with_mut(|l| l.sequence_number += 70000);
    let old = s.e.as_contract(&s.id, || {
        s.e.storage().persistent().get_ttl(&Key::Position(id))
    });
    s.e.mock_auths(&[]);
    c.keep_player(&s.p);
    s.e.as_contract(&s.id, || {
        assert!(s.e.storage().persistent().get_ttl(&Key::Position(id)) > old);
        assert!(
            s.e.storage()
                .persistent()
                .get_ttl(&Key::PlayerPositions(s.p.clone()))
                > old
        );
    });
    assert!(s.e.as_contract(&vault, || s.e.storage().instance().get_ttl()) > old);
    assert!(s.e.as_contract(&facility, || s.e.storage().instance().get_ttl()) > old);
    assert_eq!(c.positions(&s.p).len(), 1);
}

#[test]
fn immutable_wallet_access_rejects_uninvited_contributors_and_players() {
    for mode in [1, 2] {
        let s = setup_access(0, 10000, mode);
        let c = TournamentClient::new(&s.e, &s.id);
        StellarAssetClient::new(&s.e, &s.cash).mint(&s.op, &1000);
        let before = token::Client::new(&s.e, &s.cash).balance(&s.op);
        for bucket in [0, 1, 2] {
            assert_eq!(
                c.try_contribute(&s.op, &bucket, &1),
                Err(Ok(Error::NotAllowed.into()))
            );
        }
        assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.op), before);
        assert_eq!(c.totals().next_deposit, 0);
        assert_eq!(
            c.try_pre_register(&s.op, &c.terms(), &40),
            Err(Ok(Error::NotAllowed.into()))
        );
        assert!(c.registrations().is_empty());
        funded(&s);
        assert_eq!(c.registrations().len(), 2);
        c.leave(&s.p);
        c.pre_register(&s.p, &c.terms(), &40);
        assert_eq!(c.registrations().len(), 2);
    }
}

#[test]
fn access_is_part_of_consent_and_never_gates_public_closure_or_claims() {
    let s = setup_access(0, 10000, 1);
    let c = TournamentClient::new(&s.e, &s.id);
    let mut other_terms = c.config();
    other_terms.access = RoundAccess::open();
    let wrong: BytesN<32> = s.e.crypto().sha256(&other_terms.to_xdr(&s.e)).into();
    assert_eq!(
        c.try_pre_register(&s.p, &wrong, &40),
        Err(Ok(Error::Terms.into()))
    );
    active(&s);
    s.e.ledger().with_mut(|l| l.timestamp = 100);
    c.advance(&s.op);
    c.settle_player(&s.p, &s.op);
    c.settle_player(&s.q, &s.op);
    c.finalize(&s.op);
    let winner = c.totals().prize_winner.unwrap();
    let before = token::Client::new(&s.e, &s.cash).balance(&winner);
    s.e.set_auths(&[]);
    c.claim(&winner);
    assert_eq!(
        token::Client::new(&s.e, &s.cash).balance(&winner),
        before + 100
    );
    assert_eq!(c.sponsor_claim(&1), 2000);
}
