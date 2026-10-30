#![no_std]
pub use dogstar_lp_types::{LpSettings, VaultContext};
use dogstar_protocol_types::ReceiptInfo;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contractimpl, contracttype, token, vec, Address, Bytes, Env,
    Executable, IntoVal, Symbol, Vec, I256,
};

// Minimal ABI facts checked against the deployed Soroswap Testnet router/factory.
// Successful Result returns are decoded as their value; contract errors abort the call.
#[contractclient(name = "RouterClient")]
pub trait Router {
    fn get_factory(e: Env) -> Address;
    fn add_liquidity(
        e: Env,
        token_a: Address,
        token_b: Address,
        amount_a_desired: i128,
        amount_b_desired: i128,
        amount_a_min: i128,
        amount_b_min: i128,
        to: Address,
        deadline: u64,
    ) -> (i128, i128, i128);
    fn remove_liquidity(
        e: Env,
        token_a: Address,
        token_b: Address,
        liquidity: i128,
        amount_a_min: i128,
        amount_b_min: i128,
        to: Address,
        deadline: u64,
    ) -> (i128, i128);
}
#[contractclient(name = "FactoryClient")]
pub trait Factory {
    fn get_pair(e: Env, token_a: Address, token_b: Address) -> Address;
}
#[contractclient(name = "PairClient")]
pub trait Pair {
    fn sync(e: Env);
    fn token_0(e: Env) -> Address;
    fn token_1(e: Env) -> Address;
    fn factory(e: Env) -> Address;
    fn get_reserves(e: Env) -> (i128, i128);
    fn total_supply(e: Env) -> i128;
}
#[contractclient(name = "SwapClient")]
pub trait Swap {
    fn swap(e: Env, sell: Address, buy: Address, amount: i128, minimum: i128, recipient: Address);
}
#[contractclient(name = "QuoteClient")]
pub trait Quote {
    fn minimum(e: Env, sell: Address, buy: Address, amount: i128) -> i128;
}
#[contracttype]
#[derive(Clone)]
enum Key {
    Settings,
    Context,
    Owner,
    Active,
    Initialized,
    Units,
    BeforeCash,
    Before0,
    Before1,
    Idle0,
    Idle1,
    Lock,
}
#[contract]
pub struct LpVault;
fn settings(e: &Env) -> LpSettings {
    e.storage().instance().get(&Key::Settings).unwrap()
}
fn context(e: &Env) -> VaultContext {
    e.storage().instance().get(&Key::Context).unwrap()
}
fn touch(e: &Env) {
    let n = e.storage().max_ttl().min(120_960);
    e.storage().instance().extend_ttl(n / 2, n);
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
    touch(e);
}
fn check_hash(address: &Address, hash: &soroban_sdk::BytesN<32>) {
    assert!(
        address.executable() == Some(Executable::Wasm(hash.clone())),
        "external_code_changed"
    );
}
fn verify(e: &Env) {
    let s = settings(e);
    let c = context(e);
    check_hash(&s.pair, &s.pair_hash);
    check_hash(&s.router, &s.router_hash);
    check_hash(&s.factory, &s.factory_hash);
    check_hash(&s.swap_adapter, &s.swap_hash);
    check_hash(&c.quote_policy, &c.quote_hash);
    assert!(
        RouterClient::new(e, &s.router).get_factory() == s.factory
            && FactoryClient::new(e, &s.factory).get_pair(&s.asset0, &s.asset1) == s.pair,
        "pair_route_mismatch"
    );
    let pair = PairClient::new(e, &s.pair);
    assert!(
        pair.token_0() == s.asset0 && pair.token_1() == s.asset1 && pair.factory() == s.factory,
        "pair_assets_mismatch"
    );
}
fn share(e: &Env, amount: i128, units: i128, supply: i128) -> i128 {
    assert!(
        amount >= 0 && units >= 0 && supply > 0 && units <= supply,
        "invalid_lp_share"
    );
    I256::from_i128(e, amount)
        .mul(&I256::from_i128(e, units))
        .div(&I256::from_i128(e, supply))
        .to_i128()
        .unwrap()
}
fn quote(e: &Env, asset: &Address, n: i128) -> i128 {
    if n == 0 {
        return 0;
    }
    let c = context(e);
    if *asset == c.cash {
        return n;
    }
    let value = QuoteClient::new(e, &c.quote_policy).minimum(asset, &c.cash, &n);
    assert!(value > 0, "invalid_value_quote");
    value
}
fn convert(e: &Env, sell: &Address, buy: &Address, n: i128, minimum: i128) -> i128 {
    assert!(n >= 0 && minimum >= 0, "invalid_conversion");
    if n == 0 {
        assert!(minimum == 0, "minimum_not_met");
        return 0;
    }
    if sell == buy {
        assert!(n >= minimum, "minimum_not_met");
        return n;
    }
    let c = context(e);
    let s = settings(e);
    let floor = QuoteClient::new(e, &c.quote_policy).minimum(sell, buy, &n);
    let limit = floor.max(minimum);
    assert!(floor > 0, "invalid_quote");
    let me = e.current_contract_address();
    let before = token::Client::new(e, buy).balance(&me);
    token::Client::new(e, sell).transfer(&me, &s.swap_adapter, &n);
    SwapClient::new(e, &s.swap_adapter).swap(sell, buy, &n, &limit, &me);
    let received = token::Client::new(e, buy).balance(&me) - before;
    assert!(received >= limit, "conversion_delta");
    received
}
fn authorize_transfer(e: &Env, asset: &Address, to: &Address, n: i128) -> InvokerContractAuthEntry {
    InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: asset.clone(),
            fn_name: Symbol::new(e, "transfer"),
            args: (e.current_contract_address(), to.clone(), n).into_val(e),
        },
        sub_invocations: vec![e],
    })
}
#[contractimpl]
impl LpVault {
    pub fn __constructor(e: Env, s: LpSettings, c: VaultContext) {
        assert!(
            s.cash == c.cash
                && s.asset0 != s.asset1
                && c.basis >= 2
                && c.round != c.player
                && c.round != c.facility
                && matches!(c.round.executable(), Some(Executable::Wasm(_))),
            "invalid_context"
        );
        assert!(
            s.minimum_entry_bps >= 9000 && s.minimum_entry_bps <= 10000,
            "invalid_entry_floor"
        );
        let me = e.current_contract_address();
        e.storage().instance().set(
            &Key::BeforeCash,
            &token::Client::new(&e, &c.cash).balance(&me),
        );
        e.storage().instance().set(
            &Key::Before0,
            &token::Client::new(&e, &s.asset0).balance(&me),
        );
        e.storage().instance().set(
            &Key::Before1,
            &token::Client::new(&e, &s.asset1).balance(&me),
        );
        e.storage().instance().set(&Key::Owner, &c.round);
        e.storage().instance().set(&Key::Context, &c);
        e.storage().instance().set(&Key::Settings, &s);
        e.storage().instance().set(&Key::Active, &false);
        e.storage().instance().set(&Key::Initialized, &false);
        e.storage().instance().set(&Key::Units, &0i128);
        verify(&e);
        touch(&e);
    }
    pub fn controller(e: Env) -> Address {
        e.storage().instance().get(&Key::Owner).unwrap()
    }
    pub fn holdings(e: Env) -> (i128, i128, i128) {
        (
            e.storage().instance().get(&Key::Units).unwrap_or(0),
            e.storage().instance().get(&Key::Idle0).unwrap_or(0),
            e.storage().instance().get(&Key::Idle1).unwrap_or(0),
        )
    }
    pub fn info(e: Env) -> ReceiptInfo {
        let c = context(&e);
        let s = settings(&e);
        ReceiptInfo {
            controller: Self::controller(e.clone()),
            round: c.round,
            facility: c.facility,
            player: c.player,
            cash: c.cash,
            asset: s.pair,
            units: e.storage().instance().get(&Key::Units).unwrap(),
            basis: c.basis,
            active: e.storage().instance().get(&Key::Active).unwrap(),
        }
    }
    pub fn initialize(e: Env, minimums: Vec<i128>) {
        let c = context(&e);
        let s = settings(&e);
        c.adapter.require_auth();
        enter(&e);
        assert!(
            !e.storage()
                .instance()
                .get(&Key::Initialized)
                .unwrap_or(false)
                && minimums.len() == 3
                && minimums.get(2).unwrap() > 0,
            "invalid_initialization"
        );
        verify(&e);
        let me = e.current_contract_address();
        let before_cash: i128 = e.storage().instance().get(&Key::BeforeCash).unwrap();
        assert!(
            token::Client::new(&e, &c.cash).balance(&me) - before_cash == c.basis,
            "exact_cash_input_required"
        );
        let desired0 = convert(
            &e,
            &c.cash,
            &s.asset0,
            c.basis / 2,
            minimums.get(0).unwrap(),
        );
        let desired1 = convert(
            &e,
            &c.cash,
            &s.asset1,
            c.basis - c.basis / 2,
            minimums.get(1).unwrap(),
        );
        let a = token::Client::new(&e, &s.asset0);
        let b = token::Client::new(&e, &s.asset1);
        let lp = token::Client::new(&e, &s.pair);
        let before0 = a.balance(&me);
        let before1 = b.balance(&me);
        let before_units = lp.balance(&me);
        // The router pulls only the actual optimal amounts. Grant those bounded amounts after quoting its reserve ratio.
        PairClient::new(&e, &s.pair).sync();
        let reserves = PairClient::new(&e, &s.pair).get_reserves();
        assert!(
            reserves.0 > 0 && reserves.1 > 0,
            "existing_liquidity_required"
        );
        // Compute the exact router ratio with I256, without limiting the numerator to the denominator.
        let expected1 = I256::from_i128(&e, desired0)
            .mul(&I256::from_i128(&e, reserves.1))
            .div(&I256::from_i128(&e, reserves.0))
            .to_i128()
            .unwrap();
        let (used0, used1) = if expected1 <= desired1 {
            (desired0, expected1)
        } else {
            (
                I256::from_i128(&e, desired1)
                    .mul(&I256::from_i128(&e, reserves.0))
                    .div(&I256::from_i128(&e, reserves.1))
                    .to_i128()
                    .unwrap(),
                desired1,
            )
        };
        assert!(used0 > 0 && used1 > 0, "positive_liquidity_required");
        e.authorize_as_current_contract(vec![
            &e,
            authorize_transfer(&e, &s.asset0, &s.pair, used0),
            authorize_transfer(&e, &s.asset1, &s.pair, used1),
        ]);
        let reported = RouterClient::new(&e, &s.router).add_liquidity(
            &s.asset0,
            &s.asset1,
            &desired0,
            &desired1,
            &used0,
            &used1,
            &me,
            &e.ledger().timestamp().checked_add(120).unwrap(),
        );
        let units = lp.balance(&me) - before_units;
        assert!(
            before0 - a.balance(&me) == used0
                && before1 - b.balance(&me) == used1
                && reported == (used0, used1, units)
                && units >= minimums.get(2).unwrap(),
            "liquidity_delta"
        );
        let idle0 = a.balance(&me)
            - e.storage()
                .instance()
                .get::<Key, i128>(&Key::Before0)
                .unwrap();
        let idle1 = b.balance(&me)
            - e.storage()
                .instance()
                .get::<Key, i128>(&Key::Before1)
                .unwrap();
        assert!(idle0 >= 0 && idle1 >= 0, "idle_balance_delta");
        let pair = PairClient::new(&e, &s.pair);
        let reserves = pair.get_reserves();
        let supply = pair.total_supply();
        let value = quote(&e, &s.asset0, share(&e, reserves.0, units, supply) + idle0)
            .checked_add(quote(
                &e,
                &s.asset1,
                share(&e, reserves.1, units, supply) + idle1,
            ))
            .unwrap();
        let floor = I256::from_i128(&e, c.basis)
            .mul(&I256::from_i128(&e, s.minimum_entry_bps as i128))
            .div(&I256::from_i128(&e, 10000))
            .to_i128()
            .unwrap();
        assert!(value >= floor, "independent_lp_value_floor");
        e.storage().instance().set(&Key::Units, &units);
        e.storage().instance().set(&Key::Idle0, &idle0);
        e.storage().instance().set(&Key::Idle1, &idle1);
        e.storage().instance().set(&Key::Active, &true);
        e.storage().instance().set(&Key::Initialized, &true);
        leave(&e);
    }
    pub fn native_exit(e: Env, min_cash: i128, request: Bytes) -> i128 {
        let c = context(&e);
        let s = settings(&e);
        let owner = Self::controller(e.clone());
        owner.require_auth();
        enter(&e);
        assert!(
            request.is_empty()
                && min_cash >= 0
                && e.storage().instance().get(&Key::Active).unwrap_or(false),
            "invalid_exit"
        );
        verify(&e);
        let me = e.current_contract_address();
        let units: i128 = e.storage().instance().get(&Key::Units).unwrap();
        let a = token::Client::new(&e, &s.asset0);
        let b = token::Client::new(&e, &s.asset1);
        let lp = token::Client::new(&e, &s.pair);
        let supply = PairClient::new(&e, &s.pair).total_supply();
        // Pair.withdraw may also burn unsolicited shares already sitting at the pair. Only our recorded share is competitive recovery.
        let reserves = PairClient::new(&e, &s.pair).get_reserves();
        let maximum0 = share(&e, reserves.0, units, supply);
        let maximum1 = share(&e, reserves.1, units, supply);
        let before0 = a.balance(&me);
        let before1 = b.balance(&me);
        let before_units = lp.balance(&me);
        e.authorize_as_current_contract(vec![&e, authorize_transfer(&e, &s.pair, &s.pair, units)]);
        let reported = RouterClient::new(&e, &s.router).remove_liquidity(
            &s.asset0,
            &s.asset1,
            &units,
            &0,
            &0,
            &me,
            &e.ledger().timestamp().checked_add(120).unwrap(),
        );
        let received0 = a.balance(&me) - before0;
        let received1 = b.balance(&me) - before1;
        assert!(
            received0 >= 0
                && received1 >= 0
                && before_units - lp.balance(&me) == units
                && reported == (received0, received1),
            "withdrawal_delta"
        );
        let amount0 = received0.min(maximum0)
            + e.storage()
                .instance()
                .get::<Key, i128>(&Key::Idle0)
                .unwrap();
        let amount1 = received1.min(maximum1)
            + e.storage()
                .instance()
                .get::<Key, i128>(&Key::Idle1)
                .unwrap();
        let cash = convert(&e, &s.asset0, &c.cash, amount0, 0)
            .checked_add(convert(&e, &s.asset1, &c.cash, amount1, 0))
            .unwrap();
        assert!(cash >= min_cash, "minimum_cash_not_met");
        e.storage().instance().set(&Key::Active, &false);
        e.storage().instance().set(&Key::Units, &0i128);
        e.storage().instance().set(&Key::Idle0, &0i128);
        e.storage().instance().set(&Key::Idle1, &0i128);
        let recipient = if owner == c.round {
            e.storage().instance().set(&Key::Owner, &c.player);
            c.round
        } else {
            owner
        };
        if cash > 0 {
            token::Client::new(&e, &c.cash).transfer(&me, &recipient, &cash);
        }
        leave(&e);
        cash
    }
    pub fn handover(e: Env, to: Address) {
        let c = context(&e);
        c.facility.require_auth();
        enter(&e);
        assert!(
            Self::controller(e.clone()) == c.round
                && e.storage().instance().get(&Key::Active).unwrap_or(false)
                && to != c.round,
            "ownership_not_transferable"
        );
        e.storage().instance().set(&Key::Owner, &to);
        leave(&e);
    }
    pub fn recover(e: Env, asset: Address) -> i128 {
        let c = context(&e);
        let owner = Self::controller(e.clone());
        owner.require_auth();
        enter(&e);
        assert!(owner != c.round, "round_controls_position");
        let token = token::Client::new(&e, &asset);
        let n = token.balance(&e.current_contract_address());
        if n > 0 {
            token.transfer(&e.current_contract_address(), &owner, &n);
        }
        let s = settings(&e);
        if asset == s.pair {
            e.storage().instance().set(&Key::Units, &0i128);
            e.storage().instance().set(&Key::Active, &false);
        }
        if asset == s.asset0 {
            e.storage().instance().set(&Key::Idle0, &0i128);
        }
        if asset == s.asset1 {
            e.storage().instance().set(&Key::Idle1, &0i128);
        }
        leave(&e);
        n
    }
    pub fn keepalive(e: Env) {
        touch(&e);
    }
}
