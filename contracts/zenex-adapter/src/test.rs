use super::*;
use dogstar_protocol_types::ReceiptInfo;
use dogstar_zenex_types::{CloseRequest, OpenRequest, TraderState};
use soroban_sdk::{
    contractclient, contracttype,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    vec, BytesN, Executable, IntoVal, Map, Symbol, Val,
};
const VAULT_WASM: &[u8] =
    include_bytes!("../../target/wasm32v1-none/release/dogstar_zenex_vault.wasm");
#[contracttype]
#[derive(Clone)]
struct Order {
    long: bool,
    kind: u32,
    notional: i128,
    margin: i128,
}
#[contract]
struct Venue;
#[contractimpl]
impl Venue {
    pub fn __constructor(e: Env, cash: Address) {
        e.storage().instance().set(&0u32, &cash);
    }
    pub fn get_token(e: Env) -> Address {
        e.storage().instance().get(&0u32).unwrap()
    }
    pub fn get_treasury(e: Env) -> Address {
        e.current_contract_address()
    }
    pub fn get_config(e: Env) -> Map<Symbol, Val> {
        let mut m = Map::new(&e);
        m.set(Symbol::new(&e, "exec_fee"), 2i128.into_val(&e));
        m
    }
    pub fn frozen(e: Env, n: bool) {
        e.storage().instance().set(&1u32, &n);
    }
    pub fn resting(e: Env, n: bool) {
        e.storage().instance().set(&2u32, &n);
    }
    pub fn parked(e: Env, n: bool) {
        e.storage().instance().set(&3u32, &n);
    }
    pub fn wrong_version(e: Env, n: bool) {
        e.storage().instance().set(&4u32, &n);
    }
    pub fn get_trader_state(e: Env, user: Address) -> TraderState {
        assert!(
            !e.storage().instance().get(&1u32).unwrap_or(false),
            "market_frozen"
        );
        let mut p: TraderState = e.storage().persistent().get(&user).unwrap_or(TraderState {
            version: 1,
            epoch: BytesN::from_array(&e, &[7; 32]),
            sequence: 0,
            paid: 0,
            credit: 0,
            long_notional: 0,
            short_notional: 0,
            pending_orders: 0,
        });
        if e.storage().instance().get(&4u32).unwrap_or(false) {
            p.version = 2;
        }
        p
    }
    pub fn create_order(
        e: Env,
        user: Address,
        is_long: bool,
        kind: u32,
        notional: i128,
        margin: i128,
        trigger_price: i128,
        price_bound: i128,
        expiration: u32,
    ) -> u32 {
        user.require_auth();
        assert!(trigger_price == 0 && price_bound >= 0 && expiration >= e.ledger().sequence());
        let mut p = Self::get_trader_state(e.clone(), user.clone());
        let n = if kind == 0 { margin + 2 } else { 2 };
        token::Client::new(&e, &Self::get_token(e.clone())).transfer(
            &user,
            &e.current_contract_address(),
            &n,
        );
        e.storage().persistent().set(
            &(user.clone(), 0u32),
            &Order {
                long: is_long,
                kind,
                notional,
                margin,
            },
        );
        p.pending_orders += 1;
        e.storage().persistent().set(&user, &p);
        1
    }
    pub fn execute_order(e: Env, _keeper: Address, user: Address, _id: u32, price: Bytes) -> i128 {
        assert!(!price.is_empty());
        let mut p = Self::get_trader_state(e.clone(), user.clone());
        if e.storage().instance().get(&2u32).unwrap_or(false) {
            return 0;
        }
        let o: Order = e.storage().persistent().get(&(user.clone(), 0u32)).unwrap();
        if o.kind == 0 {
            if o.long {
                p.long_notional = o.notional
            } else {
                p.short_notional = o.notional
            }
            e.storage()
                .persistent()
                .set(&(user.clone(), 1u32), &o.margin);
        } else {
            let margin: i128 = e.storage().persistent().get(&(user.clone(), 1u32)).unwrap();
            let payout = margin * 2;
            token::Client::new(&e, &Self::get_token(e.clone())).transfer(
                &e.current_contract_address(),
                &user,
                &payout,
            );
            p.paid += payout;
            p.long_notional = 0;
            p.short_notional = 0;
        }
        p.sequence += 1;
        p.pending_orders = 0;
        e.storage().persistent().set(&user, &p);
        0
    }
    pub fn force(e: Env, user: Address, paid: i128, credit: i128) {
        let mut p = Self::get_trader_state(e.clone(), user.clone());
        if paid > 0 {
            token::Client::new(&e, &Self::get_token(e.clone())).transfer(
                &e.current_contract_address(),
                &user,
                &paid,
            );
        }
        p.paid += paid;
        p.credit += credit;
        p.long_notional = 0;
        p.short_notional = 0;
        p.sequence += 1;
        e.storage().persistent().set(&user, &p);
    }
    pub fn claim_credit(e: Env, user: Address) -> i128 {
        user.require_auth();
        if e.storage().instance().get(&3u32).unwrap_or(false) {
            return 0;
        }
        let mut p = Self::get_trader_state(e.clone(), user.clone());
        let n = p.credit;
        token::Client::new(&e, &Self::get_token(e.clone())).transfer(
            &e.current_contract_address(),
            &user,
            &n,
        );
        p.paid += n;
        p.credit = 0;
        p.sequence += 1;
        e.storage().persistent().set(&user, &p);
        n
    }
    pub fn reset_epoch(e: Env, user: Address) {
        let mut p = Self::get_trader_state(e.clone(), user.clone());
        p.epoch = BytesN::from_array(&e, &[8; 32]);
        e.storage().persistent().set(&user, &p);
    }
}
#[contract]
struct Quote;
#[contractimpl]
impl Quote {
    pub fn minimum(_e: Env, _sell: Address, _buy: Address, amount: i128) -> i128 {
        amount
    }
}
#[contractclient(name = "ManagedClient")]
#[allow(dead_code)]
trait Managed {
    fn info(e: Env) -> ReceiptInfo;
    fn controller(e: Env) -> Address;
    fn native_exit(e: Env, min_cash: i128, request: Bytes) -> i128;
    fn handover(e: Env, to: Address);
    fn recover(e: Env, asset: Address) -> i128;
}
#[contract]
struct Round;
#[contractimpl]
impl Round {
    pub fn open(
        e: Env,
        adapter: Address,
        player: Address,
        facility: Address,
        quote: Address,
        request: Bytes,
    ) -> Address {
        let settings = ZenexAdapterClient::new(&e, &adapter).config();
        let hash = match quote.executable() {
            Some(Executable::Wasm(h)) => h,
            _ => panic!("code"),
        };
        let c = VaultContext {
            round: e.current_contract_address(),
            player,
            facility,
            adapter: adapter.clone(),
            cash: settings.cash.clone(),
            basis: 1000,
            quote_policy: quote,
            quote_hash: hash,
        };
        token::Client::new(&e, &c.cash).transfer(&e.current_contract_address(), &adapter, &1000);
        ZenexAdapterClient::new(&e, &adapter).open(&c, &1, &vec![&e, 1000, 1], &request)
    }
    pub fn close(e: Env, vault: Address, request: Bytes) -> i128 {
        ManagedClient::new(&e, &vault).native_exit(&0, &request)
    }
}
#[contract]
struct Facility;
#[contractimpl]
impl Facility {
    pub fn take(e: Env, vault: Address, to: Address) {
        ManagedClient::new(&e, &vault).handover(&to);
    }
}
struct Setup {
    e: Env,
    cash: Address,
    market: Address,
    adapter: Address,
    round: Address,
    player: Address,
    provider: Address,
    facility: Address,
    quote: Address,
}
fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().with_mut(|l| {
        l.timestamp = 10;
        l.sequence_number = 10;
    });
    let admin = Address::generate(&e);
    let cash = e
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let market = e.register(Venue, (cash.clone(),));
    let round = e.register(Round, ());
    let facility = e.register(Facility, ());
    let quote = e.register(Quote, ());
    let code = |a: &Address| match a.executable() {
        Some(Executable::Wasm(h)) => h,
        _ => panic!("code"),
    };
    let cfg = ZenexSettings {
        cash: cash.clone(),
        settlement: cash.clone(),
        market: market.clone(),
        market_hash: code(&market),
        swap_adapter: quote.clone(),
        swap_hash: code(&quote),
        vault_wasm: e.deployer().upload_contract_wasm(VAULT_WASM),
        max_leverage_bps: 100000,
        close_fee_reserve: 10,
    };
    let adapter = e.register(ZenexAdapter, (cfg,));
    StellarAssetClient::new(&e, &cash).mint(&round, &1000);
    StellarAssetClient::new(&e, &cash).mint(&market, &10000);
    let player = Address::generate(&e);
    let provider = Address::generate(&e);
    e.mock_auths(&[]);
    Setup {
        e,
        cash,
        market,
        adapter,
        round,
        player,
        provider,
        facility,
        quote,
    }
}
fn request(s: &Setup) -> Bytes {
    OpenRequest {
        is_long: true,
        notional: 2000,
        price_bound: 100,
        price: Bytes::from_slice(&s.e, &[1]),
    }
    .to_xdr(&s.e)
}
fn close_request(s: &Setup) -> Bytes {
    CloseRequest {
        price_bound: 0,
        price: Bytes::from_slice(&s.e, &[1]),
    }
    .to_xdr(&s.e)
}
fn open(s: &Setup) -> Address {
    RoundClient::new(&s.e, &s.round).open(&s.adapter, &s.player, &s.facility, &s.quote, &request(s))
}
fn donate(s: &Setup, to: &Address, n: i128) {
    s.e.mock_all_auths();
    StellarAssetClient::new(&s.e, &s.cash).mint(to, &n);
    s.e.mock_auths(&[]);
}
#[test]
fn native_profit_is_uncapped_and_donations_are_not_competitive() {
    let s = setup();
    let vault = open(&s);
    donate(&s, &vault, 100);
    let returned = RoundClient::new(&s.e, &s.round).close(&vault, &close_request(&s));
    assert_eq!(returned, 1984);
    let info = ManagedClient::new(&s.e, &vault).info();
    assert!(!info.active);
    assert_eq!(info.controller, s.player);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&vault), 100);
}
#[test]
fn asynchronous_liquidation_and_credit_are_counted_once() {
    let s = setup();
    let vault = open(&s);
    // The forced payout originates in a separate call, outside the vault's exit transaction.
    VenueClient::new(&s.e, &s.market).force(&vault, &1234, &300);
    donate(&s, &vault, 77);
    assert_eq!(
        RoundClient::new(&s.e, &s.round).close(&vault, &Bytes::new(&s.e)),
        1544
    );
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&vault), 77);
}

#[test]
fn incomplete_credit_blocks_native_close_but_not_local_handover_or_cash_recovery() {
    let s = setup();
    let vault = open(&s);
    VenueClient::new(&s.e, &s.market).force(&vault, &100, &200);
    VenueClient::new(&s.e, &s.market).parked(&true);
    assert!(RoundClient::new(&s.e, &s.round)
        .try_close(&vault, &Bytes::new(&s.e))
        .is_err());
    VenueClient::new(&s.e, &s.market).frozen(&true);
    FacilityClient::new(&s.e, &s.facility).take(&vault, &s.provider);
    assert_eq!(ManagedClient::new(&s.e, &vault).controller(), s.provider);
    let recovered = ManagedClient::new(&s.e, &vault)
        .mock_auths(&[MockAuth {
            address: &s.provider,
            invoke: &MockAuthInvoke {
                contract: &vault,
                fn_name: "recover",
                args: (s.cash.clone(),).into_val(&s.e),
                sub_invokes: &[],
            },
        }])
        .recover(&s.cash);
    assert_eq!(recovered, 110);
}
#[test]
fn an_unfilled_open_rolls_back_escrow_and_deployment() {
    let s = setup();
    VenueClient::new(&s.e, &s.market).resting(&true);
    assert!(RoundClient::new(&s.e, &s.round)
        .try_open(&s.adapter, &s.player, &s.facility, &s.quote, &request(&s))
        .is_err());
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.round), 1000);
    VenueClient::new(&s.e, &s.market).resting(&false);
    let vault = open(&s);
    assert!(ManagedClient::new(&s.e, &vault).info().active);
}
#[test]
fn unsupported_or_reset_accounting_never_becomes_a_valid_balance_based_profit() {
    let s = setup();
    VenueClient::new(&s.e, &s.market).wrong_version(&true);
    assert!(RoundClient::new(&s.e, &s.round)
        .try_open(&s.adapter, &s.player, &s.facility, &s.quote, &request(&s))
        .is_err());
    VenueClient::new(&s.e, &s.market).wrong_version(&false);
    let vault = open(&s);
    VenueClient::new(&s.e, &s.market).reset_epoch(&vault);
    assert!(RoundClient::new(&s.e, &s.round)
        .try_close(&vault, &close_request(&s))
        .is_err());
    assert!(ManagedClient::new(&s.e, &vault).info().active);
}
#[test]
fn short_positions_close_with_the_same_wallet_and_cash_attribution_rules() {
    let s = setup();
    let r = OpenRequest {
        is_long: false,
        notional: 2000,
        price_bound: 100,
        price: Bytes::from_slice(&s.e, &[1]),
    }
    .to_xdr(&s.e);
    let vault =
        RoundClient::new(&s.e, &s.round).open(&s.adapter, &s.player, &s.facility, &s.quote, &r);
    assert_eq!(
        RoundClient::new(&s.e, &s.round).close(&vault, &close_request(&s)),
        1984
    );
}
#[test]
fn unbounded_prices_excess_leverage_and_unsigned_recovery_are_rejected() {
    let s = setup();
    for (notional, price_bound) in [(2000, 0), (100000, 100)] {
        let r = OpenRequest {
            is_long: true,
            notional,
            price_bound,
            price: Bytes::from_slice(&s.e, &[1]),
        }
        .to_xdr(&s.e);
        assert!(RoundClient::new(&s.e, &s.round)
            .try_open(&s.adapter, &s.player, &s.facility, &s.quote, &r)
            .is_err());
        assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.round), 1000);
    }
    let vault = open(&s);
    assert!(ManagedClient::new(&s.e, &vault)
        .try_native_exit(&0, &close_request(&s))
        .is_err());
    assert!(ManagedClient::new(&s.e, &vault)
        .try_recover(&s.cash)
        .is_err());
    assert!(ManagedClient::new(&s.e, &vault)
        .try_handover(&s.provider)
        .is_err());
}
