use super::*;
use aggregator::{Config, Partner, SoroswapHop};
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient};

#[contract]
struct Market;
#[contractimpl]
impl Market {
    pub fn __constructor(e: Env, c: Config) {
        e.storage().instance().set(&0u32, &c);
    }
    pub fn config(e: Env) -> Config {
        e.storage().instance().get(&0u32).unwrap()
    }
    pub fn set(e: Env, c: Config) {
        e.storage().instance().set(&0u32, &c);
    }
    pub fn swap_exact_in(
        e: Env,
        user: Address,
        token_in: Address,
        amount_in: i128,
        token_out: Address,
        min_out: i128,
        routes: Vec<Route>,
        partner: Option<Partner>,
    ) -> i128 {
        user.require_auth();
        assert!(partner.is_none());
        let c = Self::config(e.clone());
        assert_eq!(
            routes.get(0).unwrap().amount_in,
            amount_in - amount_in * c.protocol_bps as i128 / 10000
        );
        token::Client::new(&e, &token_in).transfer(
            &user,
            &e.current_contract_address(),
            &amount_in,
        );
        let received: i128 = e.storage().instance().get(&1u32).unwrap_or(min_out);
        token::Client::new(&e, &token_out).transfer(
            &e.current_contract_address(),
            &user,
            &received,
        );
        // Deliberately lie: adapter must use token deltas, not this return value.
        i128::MAX
    }
    pub fn output(e: Env, amount: i128) {
        e.storage().instance().set(&1u32, &amount);
    }
}
#[contract]
struct Round;
#[contractimpl]
impl Round {
    pub fn trade(
        e: Env,
        adapter: Address,
        sell: Address,
        buy: Address,
        amount: i128,
        minimum: i128,
    ) {
        let me = e.current_contract_address();
        token::Client::new(&e, &sell).transfer(&me, &adapter, &amount);
        SpotAdapterClient::new(&e, &adapter).swap(&sell, &buy, &amount, &minimum, &me);
    }
}
struct Setup {
    e: Env,
    market: Address,
    adapter: Address,
    round: Address,
    a: Address,
    b: Address,
}
fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let a = e
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let b = e
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let cfg = Config {
        admin: admin.clone(),
        aqua_router: Address::generate(&e),
        soroswap_router: Address::generate(&e),
        treasury: admin.clone(),
        min_partner_bps: 0,
        protocol_bps: 30,
        paused: false,
        pend_admin: None,
    };
    let market = e.register(Market, (cfg,));
    let hash = match market.executable().unwrap() {
        Executable::Wasm(h) => h,
        _ => panic!("not_wasm"),
    };
    let cfg = AdapterConfig {
        aggregator: market.clone(),
        aggregator_hash: hash,
        max_fee_bps: 50,
        routes: vec![
            &e,
            PairRoute {
                sell: a.clone(),
                buy: b.clone(),
                hops: vec![
                    &e,
                    Hop::Soroswap(SoroswapHop {
                        pair: Address::generate(&e),
                        token_in: a.clone(),
                        token_out: b.clone(),
                    }),
                ],
            },
        ],
    };
    let adapter = e.register(SpotAdapter, (cfg,));
    let round = e.register(Round, ());
    StellarAssetClient::new(&e, &a).mint(&round, &10000);
    StellarAssetClient::new(&e, &b).mint(&market, &10000);
    e.mock_auths(&[]); // The contract's nested authorization must work without a global auth bypass.
    Setup {
        e,
        market,
        adapter,
        round,
        a,
        b,
    }
}
#[test]
fn contract_custody_authorizes_exact_token_pull_and_accounts_net_output() {
    let s = setup();
    let r = RoundClient::new(&s.e, &s.round);
    MarketClient::new(&s.e, &s.market).output(&777);
    r.trade(&s.adapter, &s.a, &s.b, &1000, &700);
    assert_eq!(token::Client::new(&s.e, &s.a).balance(&s.round), 9000);
    assert_eq!(token::Client::new(&s.e, &s.b).balance(&s.round), 777);
    assert_eq!(token::Client::new(&s.e, &s.b).balance(&s.adapter), 0);
    assert_eq!(token::Client::new(&s.e, &s.a).balance(&s.adapter), 0);
    assert!(s.e.auths().is_empty());
}
#[test]
fn insufficient_output_rolls_back_prepaid_input() {
    let s = setup();
    let r = RoundClient::new(&s.e, &s.round);
    MarketClient::new(&s.e, &s.market).output(&1);
    assert!(r.try_trade(&s.adapter, &s.a, &s.b, &1000, &700).is_err());
    assert_eq!(token::Client::new(&s.e, &s.a).balance(&s.round), 10000);
    assert_eq!(token::Client::new(&s.e, &s.a).balance(&s.adapter), 0);
}
#[test]
fn fee_pause_router_change_and_unapproved_pairs_fail_closed() {
    let s = setup();
    let r = RoundClient::new(&s.e, &s.round);
    let m = MarketClient::new(&s.e, &s.market);
    let cfg = m.config();
    let mut c = cfg.clone();
    c.protocol_bps = 51;
    m.set(&c);
    assert!(r.try_trade(&s.adapter, &s.a, &s.b, &1000, &700).is_err());
    c = cfg.clone();
    c.paused = true;
    m.set(&c);
    assert!(r.try_trade(&s.adapter, &s.a, &s.b, &1000, &700).is_err());
    c = cfg.clone();
    c.soroswap_router = Address::generate(&s.e);
    m.set(&c);
    assert!(r.try_trade(&s.adapter, &s.a, &s.b, &1000, &700).is_err());
    m.set(&cfg);
    assert!(r.try_trade(&s.adapter, &s.b, &s.a, &1, &1).is_err());
    assert_eq!(token::Client::new(&s.e, &s.a).balance(&s.round), 10000);
}
#[test]
fn an_external_caller_cannot_name_a_round_as_recipient_without_auth() {
    let s = setup();
    let a = SpotAdapterClient::new(&s.e, &s.adapter);
    assert!(a.try_swap(&s.a, &s.b, &1000, &1, &s.round).is_err());
}
