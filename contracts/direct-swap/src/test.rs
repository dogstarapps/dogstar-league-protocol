use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
};
#[contract]
struct Pair;
#[contractimpl]
impl Pair {
    pub fn __constructor(e: Env, a: Address, b: Address) {
        e.storage().instance().set(&0u32, &a);
        e.storage().instance().set(&1u32, &b);
    }
    pub fn token_0(e: Env) -> Address {
        e.storage().instance().get(&0u32).unwrap()
    }
    pub fn token_1(e: Env) -> Address {
        e.storage().instance().get(&1u32).unwrap()
    }
}
#[contract]
struct Factory;
#[contractimpl]
impl Factory {
    pub fn __constructor(e: Env, pair: Address) {
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
    pub fn router_get_amounts_out(e: Env, amount_in: i128, _path: Vec<Address>) -> Vec<i128> {
        vec![&e, amount_in, amount_in * 2]
    }
    pub fn swap_exact_tokens_for_tokens(
        e: Env,
        amount_in: i128,
        _amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128> {
        to.require_auth();
        assert!(
            deadline > e.ledger().timestamp()
                && !e.storage().instance().get(&2u32).unwrap_or(false)
        );
        let pair: Address = e.storage().instance().get(&1u32).unwrap();
        token::Client::new(&e, &path.get(0).unwrap()).transfer(&to, &pair, &amount_in);
        token::Client::new(&e, &path.get(1).unwrap()).transfer(
            &e.current_contract_address(),
            &to,
            &(amount_in * 2),
        );
        vec![&e, amount_in, amount_in * 2]
    }
}
#[contract]
struct Custody;
#[contractimpl]
impl Custody {
    pub fn execute(e: Env, adapter: Address, sell: Address, buy: Address, n: i128, minimum: i128) {
        token::Client::new(&e, &sell).transfer(&e.current_contract_address(), &adapter, &n);
        DirectSwapClient::new(&e, &adapter).swap(
            &sell,
            &buy,
            &n,
            &minimum,
            &e.current_contract_address(),
        );
    }
}
struct Setup {
    e: Env,
    cash: Address,
    other: Address,
    adapter: Address,
    custody: Address,
    router: Address,
}
fn hash(address: &Address) -> BytesN<32> {
    match address.executable() {
        Some(Executable::Wasm(h)) => h,
        _ => panic!("wasm"),
    }
}
fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().with_mut(|l| l.timestamp = 10);
    let admin = Address::generate(&e);
    let cash = e
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let other = e.register_stellar_asset_contract_v2(admin).address();
    let pair = e.register(Pair, (cash.clone(), other.clone()));
    let factory = e.register(Factory, (pair.clone(),));
    let router = e.register(Router, (factory.clone(), pair.clone()));
    let c = DirectSettings {
        router: router.clone(),
        router_hash: hash(&router),
        factory: factory.clone(),
        factory_hash: hash(&factory),
        pair: pair.clone(),
        pair_hash: hash(&pair),
        asset0: cash.clone(),
        asset1: other.clone(),
    };
    let adapter = e.register(DirectSwap, (c,));
    let custody = e.register(Custody, ());
    StellarAssetClient::new(&e, &cash).mint(&custody, &1000);
    StellarAssetClient::new(&e, &other).mint(&router, &10000);
    e.mock_auths(&[]);
    Setup {
        e,
        cash,
        other,
        adapter,
        custody,
        router,
    }
}
#[test]
fn contract_custody_uses_exact_nested_token_authorization_and_measured_net_output() {
    let s = setup();
    let adapter = DirectSwapClient::new(&s.e, &s.adapter);
    assert_eq!(adapter.quote(&s.cash, &s.other, &500), 1000);
    CustodyClient::new(&s.e, &s.custody).execute(&s.adapter, &s.cash, &s.other, &500, &990);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.custody), 500);
    assert_eq!(token::Client::new(&s.e, &s.other).balance(&s.custody), 1000);
    assert_eq!(token::Client::new(&s.e, &s.other).balance(&s.adapter), 0);
}
#[test]
fn external_callers_cannot_impersonate_the_custody_recipient() {
    let s = setup();
    assert!(DirectSwapClient::new(&s.e, &s.adapter)
        .try_swap(&s.cash, &s.other, &1, &1, &s.custody)
        .is_err());
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.custody), 1000);
}
#[test]
fn a_low_output_or_frozen_venue_reverts_the_prepaid_input() {
    let s = setup();
    let custody = CustodyClient::new(&s.e, &s.custody);
    assert!(custody
        .try_execute(&s.adapter, &s.cash, &s.other, &500, &1001)
        .is_err());
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.custody), 1000);
    RouterClient::new(&s.e, &s.router).freeze(&true);
    assert!(custody
        .try_execute(&s.adapter, &s.cash, &s.other, &500, &1)
        .is_err());
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.custody), 1000);
}
