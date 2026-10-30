use super::*;
use dogstar_protocol_types::ReceiptInfo;
use soroban_sdk::{
    contractclient,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    vec, Executable, IntoVal,
};
const VAULT_WASM: &[u8] =
    include_bytes!("../../target/wasm32v1-none/release/dogstar_lp_vault.wasm");
#[contract]
struct Pair;
#[contractimpl]
impl Pair {
    pub fn __constructor(e: Env, a: Address, b: Address, factory: Address, owner: Address) {
        e.storage().instance().set(&0u32, &a);
        e.storage().instance().set(&1u32, &b);
        e.storage().instance().set(&2u32, &factory);
        e.storage().instance().set(&3u32, &100000i128);
        e.storage().persistent().set(&owner, &100000i128);
        e.storage().instance().set(&4u32, &(100000i128, 100000i128));
    }
    pub fn token_0(e: Env) -> Address {
        e.storage().instance().get(&0u32).unwrap()
    }
    pub fn token_1(e: Env) -> Address {
        e.storage().instance().get(&1u32).unwrap()
    }
    pub fn factory(e: Env) -> Address {
        e.storage().instance().get(&2u32).unwrap()
    }
    pub fn total_supply(e: Env) -> i128 {
        e.storage().instance().get(&3u32).unwrap()
    }
    pub fn get_reserves(e: Env) -> (i128, i128) {
        e.storage().instance().get(&4u32).unwrap()
    }
    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage().persistent().get(&id).unwrap_or(0)
    }
    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        assert!(amount >= 0 && Self::balance(e.clone(), from.clone()) >= amount);
        e.storage()
            .persistent()
            .set(&from, &(Self::balance(e.clone(), from.clone()) - amount));
        e.storage()
            .persistent()
            .set(&to, &(Self::balance(e.clone(), to.clone()) + amount));
    }
    pub fn bad_mint(e: Env, bad: bool) {
        e.storage().instance().set(&5u32, &bad);
    }
    pub fn sync(e: Env) {
        let me = e.current_contract_address();
        let reserves = (
            token::Client::new(&e, &Self::token_0(e.clone())).balance(&me),
            token::Client::new(&e, &Self::token_1(e.clone())).balance(&me),
        );
        e.storage().instance().set(&4u32, &reserves);
    }
    pub fn deposit(e: Env, to: Address) -> i128 {
        let me = e.current_contract_address();
        let reserves = Self::get_reserves(e.clone());
        let supply = Self::total_supply(e.clone());
        let delta0 = token::Client::new(&e, &Self::token_0(e.clone())).balance(&me) - reserves.0;
        let delta1 = token::Client::new(&e, &Self::token_1(e.clone())).balance(&me) - reserves.1;
        let units = if e.storage().instance().get(&5u32).unwrap_or(false) {
            1i128
        } else {
            (delta0 * supply / reserves.0).min(delta1 * supply / reserves.1)
        };
        e.storage().instance().set(&3u32, &(supply + units));
        e.storage()
            .persistent()
            .set(&to, &(Self::balance(e.clone(), to.clone()) + units));
        Self::sync(e);
        units
    }
    pub fn withdraw(e: Env, to: Address) -> (i128, i128) {
        let me = e.current_contract_address();
        let units = Self::balance(e.clone(), me.clone());
        let supply = Self::total_supply(e.clone());
        let a = Self::token_0(e.clone());
        let b = Self::token_1(e.clone());
        let out0 = token::Client::new(&e, &a).balance(&me) * units / supply;
        let out1 = token::Client::new(&e, &b).balance(&me) * units / supply;
        e.storage().persistent().set(&me, &0i128);
        e.storage().instance().set(&3u32, &(supply - units));
        token::Client::new(&e, &a).transfer(&me, &to, &out0);
        token::Client::new(&e, &b).transfer(&me, &to, &out1);
        Self::sync(e);
        (out0, out1)
    }
}
#[contract]
struct Factory;
#[contractimpl]
impl Factory {
    pub fn bind(e: Env, pair: Address) {
        e.storage().instance().set(&0u32, &pair);
    }
    pub fn get_pair(e: Env, _token_a: Address, _token_b: Address) -> Address {
        e.storage().instance().get(&0u32).unwrap()
    }
}
#[contract]
struct Router;
#[contractimpl]
impl Router {
    pub fn __constructor(e: Env, factory: Address, pair: Address) {
        e.storage().instance().set(&0u32, &factory);
        e.storage().instance().set(&1u32, &pair);
    }
    pub fn get_factory(e: Env) -> Address {
        e.storage().instance().get(&0u32).unwrap()
    }
    pub fn freeze(e: Env, frozen: bool) {
        e.storage().instance().set(&2u32, &frozen);
    }
    pub fn add_liquidity(
        e: Env,
        token_a: Address,
        token_b: Address,
        amount_a_desired: i128,
        amount_b_desired: i128,
        amount_a_min: i128,
        amount_b_min: i128,
        to: Address,
        deadline: u64,
    ) -> (i128, i128, i128) {
        to.require_auth();
        assert!(
            e.ledger().timestamp() < deadline
                && !e.storage().instance().get(&2u32).unwrap_or(false)
        );
        let pair: Address = e.storage().instance().get(&1u32).unwrap();
        let reserves = PairClient::new(&e, &pair).get_reserves();
        let optimal1 = amount_a_desired * reserves.1 / reserves.0;
        let (a, b) = if optimal1 <= amount_b_desired {
            (amount_a_desired, optimal1)
        } else {
            (amount_b_desired * reserves.0 / reserves.1, amount_b_desired)
        };
        assert!(a >= amount_a_min && b >= amount_b_min);
        token::Client::new(&e, &token_a).transfer(&to, &pair, &a);
        token::Client::new(&e, &token_b).transfer(&to, &pair, &b);
        let units = PairClient::new(&e, &pair).deposit(&to);
        (a, b, units)
    }
    pub fn remove_liquidity(
        e: Env,
        _token_a: Address,
        _token_b: Address,
        liquidity: i128,
        amount_a_min: i128,
        amount_b_min: i128,
        to: Address,
        deadline: u64,
    ) -> (i128, i128) {
        to.require_auth();
        assert!(
            e.ledger().timestamp() < deadline
                && !e.storage().instance().get(&2u32).unwrap_or(false)
        );
        let pair: Address = e.storage().instance().get(&1u32).unwrap();
        token::Client::new(&e, &pair).transfer(&to, &pair, &liquidity);
        let out = PairClient::new(&e, &pair).withdraw(&to);
        assert!(out.0 >= amount_a_min && out.1 >= amount_b_min);
        out
    }
}
#[contract]
struct Quote;
#[contractimpl]
impl Quote {
    pub fn minimum(_e: Env, _sell: Address, _buy: Address, amount: i128) -> i128 {
        amount * 99 / 100
    }
}
#[contract]
struct Swap;
#[contractimpl]
impl Swap {
    pub fn swap(
        e: Env,
        _sell: Address,
        buy: Address,
        amount: i128,
        minimum: i128,
        recipient: Address,
    ) {
        assert!(amount >= minimum);
        token::Client::new(&e, &buy).transfer(&e.current_contract_address(), &recipient, &amount);
    }
}
#[contractclient(name = "ManagedClient")]
#[allow(dead_code)]
trait Managed {
    fn info(e: Env) -> ReceiptInfo;
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
        n: i128,
    ) -> Address {
        let cfg = LpAdapterClient::new(&e, &adapter).config();
        let c = VaultContext {
            round: e.current_contract_address(),
            player,
            facility,
            adapter: adapter.clone(),
            cash: cfg.cash.clone(),
            basis: n,
            quote_policy: quote.clone(),
            quote_hash: hash(&quote),
        };
        token::Client::new(&e, &cfg.cash).transfer(&e.current_contract_address(), &adapter, &n);
        LpAdapterClient::new(&e, &adapter).open(
            &c,
            &0,
            &vec![&e, n / 2, n - n / 2, 1],
            &Bytes::new(&e),
        )
    }
    pub fn close(e: Env, vault: Address) -> i128 {
        ManagedClient::new(&e, &vault).native_exit(&0, &Bytes::new(&e))
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
fn hash(address: &Address) -> BytesN<32> {
    match address.executable() {
        Some(Executable::Wasm(h)) => h,
        _ => panic!("wasm"),
    }
}
struct Setup {
    e: Env,
    cash: Address,
    other: Address,
    pair: Address,
    router: Address,
    adapter: Address,
    round: Address,
    quote: Address,
    facility: Address,
    player: Address,
    provider: Address,
    owner: Address,
}
fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().with_mut(|l| l.timestamp = 10);
    let owner = Address::generate(&e);
    let player = Address::generate(&e);
    let provider = Address::generate(&e);
    let cash = e
        .register_stellar_asset_contract_v2(owner.clone())
        .address();
    let other = e
        .register_stellar_asset_contract_v2(owner.clone())
        .address();
    let factory = e.register(Factory, ());
    let pair = e.register(
        Pair,
        (cash.clone(), other.clone(), factory.clone(), owner.clone()),
    );
    FactoryClient::new(&e, &factory).bind(&pair);
    let router = e.register(Router, (factory.clone(), pair.clone()));
    let quote = e.register(Quote, ());
    let swap = e.register(Swap, ());
    let round = e.register(Round, ());
    let facility = e.register(Facility, ());
    let cfg = LpSettings {
        cash: cash.clone(),
        asset0: cash.clone(),
        asset1: other.clone(),
        pair: pair.clone(),
        pair_hash: hash(&pair),
        router: router.clone(),
        router_hash: hash(&router),
        factory: factory.clone(),
        factory_hash: hash(&factory),
        swap_adapter: swap.clone(),
        swap_hash: hash(&swap),
        vault_wasm: e.deployer().upload_contract_wasm(VAULT_WASM),
        minimum_entry_bps: 9800,
    };
    let adapter = e.register(LpAdapter, (cfg,));
    for asset in [&cash, &other] {
        StellarAssetClient::new(&e, asset).mint(&pair, &100000);
        StellarAssetClient::new(&e, asset).mint(&swap, &1000000);
    }
    StellarAssetClient::new(&e, &cash).mint(&round, &1000);
    e.mock_auths(&[]);
    Setup {
        e,
        cash,
        other,
        pair,
        router,
        adapter,
        round,
        quote,
        facility,
        player,
        provider,
        owner,
    }
}
fn open(s: &Setup) -> Address {
    RoundClient::new(&s.e, &s.round).open(&s.adapter, &s.player, &s.facility, &s.quote, &1000)
}
#[test]
fn lp_round_trip_and_native_nav_growth_use_real_share_and_cash_deltas() {
    let s = setup();
    let vault = open(&s);
    assert_eq!(ManagedClient::new(&s.e, &vault).info().units, 500);
    s.e.mock_all_auths();
    StellarAssetClient::new(&s.e, &s.cash).mint(&s.pair, &10050);
    StellarAssetClient::new(&s.e, &s.other).mint(&s.pair, &10050);
    PairClient::new(&s.e, &s.pair).sync();
    s.e.mock_auths(&[]);
    assert_eq!(RoundClient::new(&s.e, &s.round).close(&vault), 1100);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.round), 1100);
    assert_eq!(ManagedClient::new(&s.e, &vault).info().controller, s.player);
}
#[test]
fn unsolicited_vault_assets_and_shares_at_the_pair_do_not_inflate_recovery() {
    let s = setup();
    let vault = open(&s);
    s.e.mock_all_auths();
    StellarAssetClient::new(&s.e, &s.cash).mint(&vault, &200);
    StellarAssetClient::new(&s.e, &s.other).mint(&vault, &300);
    let lp = token::Client::new(&s.e, &s.pair);
    lp.transfer(&s.owner, &s.pair, &100);
    lp.transfer(&s.owner, &vault, &50);
    s.e.mock_auths(&[]);
    assert_eq!(RoundClient::new(&s.e, &s.round).close(&vault), 1000);
    assert_eq!(lp.balance(&vault), 50);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&vault), 300);
    assert_eq!(token::Client::new(&s.e, &s.other).balance(&vault), 400);
}
#[test]
fn a_bad_share_mint_fails_the_independent_value_floor_and_rolls_back_all_inputs() {
    let s = setup();
    PairClient::new(&s.e, &s.pair).bad_mint(&true);
    assert!(RoundClient::new(&s.e, &s.round)
        .try_open(&s.adapter, &s.player, &s.facility, &s.quote, &1000)
        .is_err());
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.round), 1000);
    assert_eq!(
        PairClient::new(&s.e, &s.pair).get_reserves(),
        (100000, 100000)
    );
}
#[test]
fn unsynchronized_pool_token_surplus_does_not_become_our_competition_return() {
    let s = setup();
    let vault = open(&s);
    s.e.mock_all_auths();
    StellarAssetClient::new(&s.e, &s.cash).mint(&s.pair, &1000);
    StellarAssetClient::new(&s.e, &s.other).mint(&s.pair, &1000);
    s.e.mock_auths(&[]);
    assert_eq!(RoundClient::new(&s.e, &s.round).close(&vault), 1000);
    assert!(token::Client::new(&s.e, &s.cash).balance(&vault) > 0);
}
#[test]
fn frozen_router_cannot_block_local_handover_or_new_owner_share_recovery() {
    let s = setup();
    let vault = open(&s);
    RouterClient::new(&s.e, &s.router).freeze(&true);
    assert!(RoundClient::new(&s.e, &s.round).try_close(&vault).is_err());
    FacilityClient::new(&s.e, &s.facility).take(&vault, &s.provider);
    assert!(RoundClient::new(&s.e, &s.round).try_close(&vault).is_err());
    s.e.mock_auths(&[MockAuth {
        address: &s.provider,
        invoke: &MockAuthInvoke {
            contract: &vault,
            fn_name: "recover",
            args: (s.pair.clone(),).into_val(&s.e),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(ManagedClient::new(&s.e, &vault).recover(&s.pair), 500);
    assert_eq!(token::Client::new(&s.e, &s.pair).balance(&s.provider), 500);
    assert!(!ManagedClient::new(&s.e, &vault).info().active);
}
