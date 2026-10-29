#![no_std]
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token, xdr::ToXdr, Address, BytesN, Env, Executable, IntoVal, Map, Vec, I256,
};

pub use dogstar_protocol_types::{Calendar, Config, FacilityConfig, ReceiptInfo};
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Player {
    pub settled: bool,
    pub claimed: bool,
    pub recovery: i128,
    pub payout: i128,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Registration {
    pub valid_until: u64,
    pub confirmed: bool,
    pub withdrawn: bool,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub player: Address,
    pub sell: Address,
    pub buy: Address,
    pub amount: i128,
    pub minimum: i128,
    pub expires: u64,
    pub open: bool,
    pub premium: i128,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Residual {
    pub owner: Address,
    pub asset: Address,
    pub units: i128,
    pub claimed: bool,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Contribution {
    pub owner: Address,
    pub bucket: u32,
    pub amount: i128,
    pub claimed: bool,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Totals {
    pub capital: i128,
    pub prizes: i128,
    pub execution: i128,
    pub fee_reserved: i128,
    pub open_orders: u32,
    pub allocated: i128,
    pub sponsor: i128,
    pub players: u32,
    pub settled: u32,
    pub next_order: u32,
    pub next_deposit: u32,
    pub prize_winner: Option<Address>,
    pub best_recovery: i128,
}
#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    AdapterHashes,
    PolicyHash,
    Eligible,
    Prepared,
    Terms,
    Phase,
    Totals,
    Registrations,
    Reg(Address),
    Player(Address),
    Balance(Address, Address),
    Order(u32),
    Contribution(u32),
    Weight(u32),
    Lock,
    Facility,
    ReceiptNonce,
    Receipt(Address, Address),
    Residual(Address),
    PlayerOrders(Address),
    OpenOrders,
    OwnerDeposits(Address),
}
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidConfig = 1,
    Window = 2,
    State = 3,
    Funds = 4,
    Terms = 5,
    Duplicate = 6,
    NotAllowed = 7,
    Price = 8,
    Pending = 9,
    Consumed = 10,
    Reentrant = 11,
}
// The policy must enforce independent prices, freshness, allowed pairs and minimum net recovery.
// Admission and external protocol behavior require separate integration verification.
#[contractclient(name = "QuoteClient")]
pub trait QuotePolicy {
    fn minimum(env: Env, sell: Address, buy: Address, amount: i128) -> i128;
}
#[contractclient(name = "SwapClient")]
pub trait SwapAdapter {
    fn swap(env: Env, sell: Address, buy: Address, amount: i128, minimum: i128, recipient: Address);
}
#[contractclient(name = "FacilityClient")]
pub trait Facility {
    fn available(e: Env) -> i128;
    fn reserve(e: Env, vault: Address, n: i128);
    fn adjust(e: Env, vault: Address, n: i128);
    fn release(e: Env, vault: Address);
    fn purchase(e: Env, vault: Address) -> i128;
}
#[contractclient(name = "ReceiptClient")]
pub trait Receipt {
    fn info(e: Env) -> ReceiptInfo;
    fn update(e: Env, units: i128, basis: i128);
}
#[contractevent(topics=["phase"])]
#[derive(Clone)]
pub struct PhaseEvent {
    pub phase: u32,
}
#[contractevent(topics=["funding"])]
#[derive(Clone)]
pub struct FundingEvent {
    #[topic]
    pub id: u32,
    pub owner: Address,
    pub bucket: u32,
    pub amount: i128,
}
#[contractevent(topics=["limit"])]
#[derive(Clone)]
pub struct LimitEvent {
    #[topic]
    pub id: u32,
    pub player: Address,
    pub sell: Address,
    pub buy: Address,
    pub amount: i128,
    pub minimum: i128,
    pub expires: u64,
}
#[contractevent(topics=["order_end"])]
#[derive(Clone)]
pub struct OrderEndEvent {
    #[topic]
    pub id: u32,
    pub player: Address,
    pub filled: bool,
}
#[contractevent(topics=["settled"])]
#[derive(Clone)]
pub struct SettledEvent {
    #[topic]
    pub player: Address,
    pub recovery: i128,
    pub payout: i128,
}
#[contractevent(topics=["execution_reward"])]
#[derive(Clone)]
pub struct RewardPaid {
    #[topic]
    pub operator: Address,
    pub amount: i128,
}
#[contract]
pub struct Tournament;
fn cfg(e: &Env) -> Config {
    e.storage().instance().get(&Key::Config).unwrap()
}
fn wasm_hash(e: &Env, address: &Address) -> BytesN<32> {
    match address.executable() {
        Some(Executable::Wasm(hash)) => hash,
        _ => panic_with_error!(e, Error::NotAllowed),
    }
}
fn total(e: &Env) -> Totals {
    e.storage().instance().get(&Key::Totals).unwrap()
}
fn put_total(e: &Env, t: &Totals) {
    e.storage().instance().set(&Key::Totals, t);
}
fn phase(e: &Env) -> u32 {
    e.storage().instance().get(&Key::Phase).unwrap()
}
fn set_phase(e: &Env, p: u32) {
    e.storage().instance().set(&Key::Phase, &p);
    PhaseEvent { phase: p }.publish(e);
}
fn check(e: &Env, b: bool, err: Error) {
    if !b {
        panic_with_error!(e, err)
    }
}
fn now(e: &Env) -> u64 {
    e.ledger().timestamp()
}
fn touch(e: &Env) {
    let target = e.storage().max_ttl();
    e.storage().instance().extend_ttl(target / 2, target);
}
fn store<T: IntoVal<Env, soroban_sdk::Val>>(e: &Env, k: &Key, v: &T) {
    e.storage().persistent().set(k, v);
    let target = e.storage().max_ttl();
    e.storage().persistent().extend_ttl(k, target / 2, target);
}
fn balance(e: &Env, p: &Address, a: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::Balance(p.clone(), a.clone()))
        .unwrap_or(0)
}
fn credit(e: &Env, p: &Address, a: &Address, n: i128) {
    let next = balance(e, p, a).checked_add(n).unwrap();
    check(e, next >= 0, Error::Funds);
    store(e, &Key::Balance(p.clone(), a.clone()), &next);
}
fn player(e: &Env, p: &Address) -> Player {
    e.storage()
        .persistent()
        .get(&Key::Player(p.clone()))
        .unwrap()
}
fn pay(e: &Env, to: &Address, n: i128) {
    if n > 0 {
        token::Client::new(e, &cfg(e).cash).transfer(&e.current_contract_address(), to, &n);
    }
}
fn lock(e: &Env) {
    check(
        e,
        !e.storage().instance().get(&Key::Lock).unwrap_or(false),
        Error::Reentrant,
    );
    e.storage().instance().set(&Key::Lock, &true);
}
fn unlock(e: &Env) {
    e.storage().instance().set(&Key::Lock, &false);
    touch(e);
}
fn reward(e: &Env, operator: &Address, t: &mut Totals) {
    check(
        e,
        t.execution - t.fee_reserved >= cfg(e).reward,
        Error::Funds,
    );
    t.execution -= cfg(e).reward;
    put_total(e, t);
    pay(e, operator, cfg(e).reward);
    RewardPaid {
        operator: operator.clone(),
        amount: cfg(e).reward,
    }
    .publish(e);
}
fn activation_funded(e: &Env, c: &Config, t: &Totals) -> bool {
    t.capital >= c.capital * c.max_players as i128
        && t.prizes >= c.prizes
        && t.execution >= c.execution
        && !c.exit.terms().is_some_and(|exit| {
            FacilityClient::new(e, &facility(e)).available() < exit.minimum_coverage
        })
}
fn is_trading(e: &Env, increase: bool) {
    let c = cfg(e);
    check(
        e,
        phase(e) == 3
            && now(e) >= c.calendar.start
            && now(e)
                < if increase {
                    c.calendar.risk_cutoff
                } else {
                    c.calendar.end
                },
        Error::Window,
    );
}
fn facility(e: &Env) -> Address {
    e.storage().instance().get(&Key::Facility).unwrap()
}
fn ratio(e: &Env, amount: i128, numerator: i128, denominator: i128) -> i128 {
    I256::from_i128(e, amount)
        .mul(&I256::from_i128(e, numerator))
        .div(&I256::from_i128(e, denominator))
        .to_i128()
        .unwrap()
}
fn premium(e: &Env, sell: &Address, buy: &Address, n: i128) -> i128 {
    let c = cfg(e);
    if sell != &c.cash || buy == &c.cash {
        return 0;
    }
    let bps = c.exit.terms().unwrap().clone().premium_bps as i128;
    // Round up the disclosed premium, so splitting a trade cannot waive it.
    I256::from_i128(e, n)
        .mul(&I256::from_i128(e, bps))
        .add(&I256::from_i128(e, 9999))
        .div(&I256::from_i128(e, 10000))
        .to_i128()
        .unwrap()
}
fn update_receipt(e: &Env, p: &Address, asset: &Address, units: i128, basis: i128) {
    let c = cfg(e);
    let exit = c.exit.terms().unwrap().clone();
    let facility = facility(e);
    let key = Key::Receipt(p.clone(), asset.clone());
    let previous: Option<Address> = e.storage().persistent().get(&key);
    if let Some(vault) = previous {
        ReceiptClient::new(e, &vault).update(&units, &basis);
        if units == 0 {
            FacilityClient::new(e, &facility).release(&vault);
            e.storage().persistent().remove(&key);
        } else {
            FacilityClient::new(e, &facility)
                .adjust(&vault, &ratio(e, basis, exit.fallback_bps as i128, 10000));
            store(e, &key, &vault);
        }
    } else if units > 0 {
        let nonce: u32 = e.storage().instance().get(&Key::ReceiptNonce).unwrap_or(0);
        let salt: BytesN<32> = e
            .crypto()
            .sha256(&(p.clone(), asset.clone(), nonce).to_xdr(e))
            .into();
        let info = ReceiptInfo {
            controller: e.current_contract_address(),
            round: e.current_contract_address(),
            facility: facility.clone(),
            player: p.clone(),
            cash: c.cash,
            asset: asset.clone(),
            units,
            basis,
            active: true,
        };
        let vault = e
            .deployer()
            .with_current_contract(salt)
            .deploy_v2(exit.artifacts.spot_receipt_wasm, (info,));
        e.storage()
            .instance()
            .set(&Key::ReceiptNonce, &nonce.checked_add(1).unwrap());
        FacilityClient::new(e, &facility)
            .reserve(&vault, &ratio(e, basis, exit.fallback_bps as i128, 10000));
        store(e, &key, &vault);
    }
}
fn account_swap(e: &Env, p: &Address, sell: &Address, buy: &Address, n: i128, received: i128) {
    let c = cfg(e);
    let carried_basis = if sell == &c.cash {
        n
    } else {
        let vault: Address = e
            .storage()
            .persistent()
            .get(&Key::Receipt(p.clone(), sell.clone()))
            .unwrap();
        let r = ReceiptClient::new(e, &vault).info();
        check(
            e,
            r.units >= n && r.active && r.controller == e.current_contract_address(),
            Error::State,
        );
        let basis = ratio(e, r.basis, n, r.units);
        update_receipt(e, p, sell, r.units - n, r.basis - basis);
        basis
    };
    if buy != &c.cash {
        let vault: Option<Address> = e
            .storage()
            .persistent()
            .get(&Key::Receipt(p.clone(), buy.clone()));
        let (units, basis) = vault
            .map(|v| {
                let r = ReceiptClient::new(e, &v).info();
                (r.units, r.basis)
            })
            .unwrap_or((0, 0));
        update_receipt(
            e,
            p,
            buy,
            units.checked_add(received).unwrap(),
            basis.checked_add(carried_basis).unwrap(),
        );
    }
    let fee = premium(e, sell, buy, n);
    if fee > 0 {
        credit(e, p, &c.cash, -fee);
        pay(e, &c.exit.terms().unwrap().clone().provider, fee);
    }
}
fn active_orders(e: &Env, p: &Address) -> Vec<u32> {
    e.storage()
        .persistent()
        .get(&Key::PlayerOrders(p.clone()))
        .unwrap_or(Vec::new(e))
}
fn remove_order(e: &Env, id: u32, p: &Address) {
    let mut own = active_orders(e, p);
    own.remove(own.first_index_of(id).unwrap());
    store(e, &Key::PlayerOrders(p.clone()), &own);
    let mut all: Vec<u32> = e
        .storage()
        .instance()
        .get(&Key::OpenOrders)
        .unwrap_or(Vec::new(e));
    all.remove(all.first_index_of(id).unwrap());
    e.storage().instance().set(&Key::OpenOrders, &all);
}
fn swap(
    e: &Env,
    p: &Address,
    sell: &Address,
    buy: &Address,
    n: i128,
    min_out: i128,
    adapter: &Address,
) -> i128 {
    let c = cfg(e);
    check(
        e,
        c.assets.contains(sell)
            && c.assets.contains(buy)
            && sell != buy
            && c.adapters.contains(adapter)
            && n > 0,
        Error::NotAllowed,
    );
    let hashes: Map<Address, BytesN<32>> = e.storage().instance().get(&Key::AdapterHashes).unwrap();
    let policy_hash: BytesN<32> = e.storage().instance().get(&Key::PolicyHash).unwrap();
    check(
        e,
        hashes.get(adapter.clone()) == Some(wasm_hash(e, adapter))
            && policy_hash == wasm_hash(e, &c.quote_policy),
        Error::NotAllowed,
    );
    check(e, balance(e, p, sell) >= n, Error::Funds);
    let floor = QuoteClient::new(e, &c.quote_policy).minimum(sell, buy, &n);
    check(e, floor > 0 && min_out >= floor, Error::Price);
    let address = e.current_contract_address();
    let before = token::Client::new(e, buy).balance(&address);
    credit(e, p, sell, -n);
    token::Client::new(e, sell).transfer(&address, adapter, &n);
    SwapClient::new(e, adapter).swap(sell, buy, &n, &min_out, &address);
    let received = token::Client::new(e, buy).balance(&address) - before;
    check(e, received >= min_out, Error::Price);
    credit(e, p, buy, received);
    account_swap(e, p, sell, buy, n, received);
    received
}
#[contractimpl]
impl Tournament {
    pub fn __constructor(e: Env, c: Config) {
        c.creator.require_auth();
        let d = &c.calendar;
        check(
            &e,
            c.capital > 0
                && c.capital < (1i128 << 50)
                && c.prizes >= 0
                && c.prizes < (1i128 << 50)
                && c.execution >= 0
                && c.execution < (1i128 << 50)
                && c.reward >= 0
                && c.reward < (1i128 << 50)
                && c.max_players >= c.min_players
                && c.min_players > 0
                && c.max_players <= 50
                && c.share_bps <= 10000,
            Error::InvalidConfig,
        );
        for i in 0..c.assets.len() {
            for j in i + 1..c.assets.len() {
                check(&e, c.assets.get(i) != c.assets.get(j), Error::InvalidConfig);
            }
        }
        check(
            &e,
            c.execution
                >= c.reward
                    * (4 + c.max_players as i128 * c.assets.len() as i128
                        + c.max_players.div_ceil(5) as i128)
                && c.assets.len() <= 10
                && c.assets.contains(&c.cash)
                && c.adapters.len() <= 5,
            Error::InvalidConfig,
        );
        check(
            &e,
            d.funding_open < d.funding_close
                && d.registration_open < d.registration_close
                && d.funding_close <= d.registration_close
                && d.registration_close <= d.prepare_by
                && d.prepare_by < d.start
                && d.start < d.risk_cutoff
                && d.risk_cutoff <= d.end
                && d.end < d.settle_by
                && now(&e) < d.funding_close,
            Error::InvalidConfig,
        );
        if let Some(exit) = c.exit.terms() {
            check(
                &e,
                exit.provider != e.current_contract_address()
                    && exit.fallback_bps > 0
                    && exit.fallback_bps <= 10000
                    && exit.premium_bps <= 1000
                    && exit.minimum_coverage
                        >= ratio(
                            &e,
                            c.capital * c.max_players as i128,
                            exit.fallback_bps as i128,
                            10000,
                        ),
                Error::InvalidConfig,
            );
            let fc = FacilityConfig {
                cash: c.cash.clone(),
                controller: e.current_contract_address(),
                provider: exit.provider.clone(),
                risk_cutoff: c.calendar.risk_cutoff,
                purchase_at: c.calendar.settle_by,
                round_terms: e.crypto().sha256(&c.clone().to_xdr(&e)).into(),
            };
            let address = e
                .deployer()
                .with_current_contract(BytesN::from_array(&e, &[69; 32]))
                .deploy_v2(exit.artifacts.facility_wasm.clone(), (fc,));
            e.storage().instance().set(&Key::Facility, &address);
        } else {
            check(
                &e,
                c.adapters.is_empty() && c.assets.len() == 1,
                Error::InvalidConfig,
            );
        }
        let terms: BytesN<32> = e.crypto().sha256(&c.clone().to_xdr(&e)).into();
        let mut hashes = Map::<Address, BytesN<32>>::new(&e);
        for adapter in c.adapters.iter() {
            check(
                &e,
                !hashes.contains_key(adapter.clone()),
                Error::InvalidConfig,
            );
            hashes.set(adapter.clone(), wasm_hash(&e, &adapter));
        }
        e.storage().instance().set(&Key::AdapterHashes, &hashes);
        e.storage()
            .instance()
            .set(&Key::PolicyHash, &wasm_hash(&e, &c.quote_policy));
        e.storage().instance().set(&Key::Config, &c);
        e.storage().instance().set(&Key::Terms, &terms);
        set_phase(&e, 0);
        e.storage()
            .instance()
            .set(&Key::Registrations, &Vec::<Address>::new(&e));
        put_total(
            &e,
            &Totals {
                capital: 0,
                prizes: 0,
                execution: 0,
                fee_reserved: 0,
                open_orders: 0,
                allocated: 0,
                sponsor: 0,
                players: 0,
                settled: 0,
                next_order: 0,
                next_deposit: 0,
                prize_winner: None,
                best_recovery: -1,
            },
        );
        touch(&e);
    }
    pub fn config(e: Env) -> Config {
        cfg(&e)
    }
    pub fn exit_facility(e: Env) -> Option<Address> {
        e.storage().instance().get(&Key::Facility)
    }
    pub fn spot_receipt(e: Env, p: Address, asset: Address) -> Option<Address> {
        e.storage().persistent().get(&Key::Receipt(p, asset))
    }
    pub fn residual(e: Env, vault: Address) -> Residual {
        e.storage().persistent().get(&Key::Residual(vault)).unwrap()
    }
    pub fn open_orders(e: Env) -> Vec<u32> {
        e.storage()
            .instance()
            .get(&Key::OpenOrders)
            .unwrap_or(Vec::new(&e))
    }
    pub fn player_orders(e: Env, p: Address) -> Vec<u32> {
        active_orders(&e, &p)
    }
    pub fn owner_deposits(
        e: Env,
        owner: Address,
        offset: u32,
        limit: u32,
    ) -> Vec<(u32, Contribution)> {
        check(&e, limit <= 20, Error::NotAllowed);
        let ids: Vec<u32> = e
            .storage()
            .persistent()
            .get(&Key::OwnerDeposits(owner))
            .unwrap_or(Vec::new(&e));
        let mut out = Vec::new(&e);
        for i in offset..offset.saturating_add(limit).min(ids.len()) {
            let id = ids.get(i).unwrap();
            out.push_back((id, Self::contribution(e.clone(), id)));
        }
        out
    }
    pub fn adapter_hash(e: Env, adapter: Address) -> BytesN<32> {
        let hashes: Map<Address, BytesN<32>> =
            e.storage().instance().get(&Key::AdapterHashes).unwrap();
        hashes.get(adapter).unwrap()
    }
    pub fn policy_hash(e: Env) -> BytesN<32> {
        e.storage().instance().get(&Key::PolicyHash).unwrap()
    }
    pub fn terms(e: Env) -> BytesN<32> {
        e.storage().instance().get(&Key::Terms).unwrap()
    }
    pub fn phase(e: Env) -> u32 {
        phase(&e)
    }
    pub fn totals(e: Env) -> Totals {
        total(&e)
    }
    pub fn player(e: Env, p: Address) -> Player {
        player(&e, &p)
    }
    pub fn balance(e: Env, p: Address, asset: Address) -> i128 {
        balance(&e, &p, &asset)
    }
    pub fn registrations(e: Env) -> Vec<Address> {
        e.storage().instance().get(&Key::Registrations).unwrap()
    }
    pub fn registration(e: Env, p: Address) -> Registration {
        e.storage().persistent().get(&Key::Reg(p)).unwrap()
    }
    pub fn order(e: Env, id: u32) -> Order {
        e.storage().persistent().get(&Key::Order(id)).unwrap()
    }
    pub fn contribution(e: Env, id: u32) -> Contribution {
        e.storage()
            .persistent()
            .get(&Key::Contribution(id))
            .unwrap()
    }
    pub fn contributions_page(e: Env, offset: u32, limit: u32) -> Vec<(u32, Contribution)> {
        check(&e, limit <= 20, Error::InvalidConfig);
        let count = total(&e).next_deposit;
        let mut out = Vec::new(&e);
        for i in offset..offset.saturating_add(limit).min(count) {
            let id = i + 1;
            out.push_back((id, Self::contribution(e.clone(), id)));
        }
        out
    }
    pub fn orders_page(e: Env, offset: u32, limit: u32) -> Vec<(u32, Order)> {
        check(&e, limit <= 20, Error::InvalidConfig);
        let count = total(&e).next_order;
        let mut out = Vec::new(&e);
        for i in offset..offset.saturating_add(limit).min(count) {
            let id = i + 1;
            out.push_back((id, Self::order(e.clone(), id)));
        }
        out
    }
    pub fn portfolio(e: Env, p: Address) -> Vec<(Address, i128)> {
        let mut out = Vec::new(&e);
        for a in cfg(&e).assets.iter() {
            out.push_back((a.clone(), balance(&e, &p, &a)));
        }
        out
    }
    pub fn contribute(e: Env, owner: Address, bucket: u32, n: i128) -> u32 {
        owner.require_auth();
        lock(&e);
        let c = cfg(&e);
        let mut t = total(&e);
        check(
            &e,
            phase(&e) == 0
                && now(&e) >= c.calendar.funding_open
                && now(&e) < c.calendar.funding_close
                && n > 0
                && bucket <= 2,
            Error::Window,
        );
        let (current, cap) = if bucket == 0 {
            (t.capital, c.capital * c.max_players as i128)
        } else if bucket == 1 {
            (t.prizes, c.prizes)
        } else {
            (t.execution, c.execution)
        };
        check(&e, n <= cap - current, Error::Funds);
        let owner_key = Key::OwnerDeposits(owner.clone());
        let mut deposits: Vec<u32> = e
            .storage()
            .persistent()
            .get(&owner_key)
            .unwrap_or(Vec::new(&e));
        check(
            &e,
            deposits.len() < 128 && t.next_deposit < 10000,
            Error::NotAllowed,
        );
        token::Client::new(&e, &c.cash).transfer(&owner, &e.current_contract_address(), &n);
        if bucket == 0 {
            t.capital += n
        } else if bucket == 1 {
            t.prizes += n
        } else {
            t.execution += n
        };
        t.next_deposit += 1;
        deposits.push_back(t.next_deposit);
        store(&e, &owner_key, &deposits);
        let weight: i128 = e
            .storage()
            .persistent()
            .get(&Key::Weight(bucket))
            .unwrap_or(0);
        store(&e, &Key::Weight(bucket), &(weight + n));
        FundingEvent {
            id: t.next_deposit,
            owner: owner.clone(),
            bucket,
            amount: n,
        }
        .publish(&e);
        store(
            &e,
            &Key::Contribution(t.next_deposit),
            &Contribution {
                owner: owner.clone(),
                bucket,
                amount: n,
                claimed: false,
            },
        );
        put_total(&e, &t);
        unlock(&e);
        t.next_deposit
    }
    pub fn pre_register(e: Env, p: Address, terms: BytesN<32>, valid_until: u64) {
        p.require_auth();
        lock(&e);
        let c = cfg(&e);
        check(
            &e,
            phase(&e) <= 1
                && now(&e) >= c.calendar.registration_open
                && now(&e) < c.calendar.registration_close,
            Error::Window,
        );
        check(
            &e,
            terms == Self::terms(e.clone()) && valid_until >= c.calendar.registration_close,
            Error::Terms,
        );
        let mut list: Vec<Address> = e.storage().instance().get(&Key::Registrations).unwrap();
        if let Some(reg) = e
            .storage()
            .persistent()
            .get::<Key, Registration>(&Key::Reg(p.clone()))
        {
            if !reg.withdrawn {
                unlock(&e);
                return;
            }
        }
        check(
            &e,
            list.len() < c.max_players || list.contains(&p),
            Error::Funds,
        );
        if !list.contains(&p) {
            list.push_back(p.clone());
        }
        e.storage().instance().set(&Key::Registrations, &list);
        store(
            &e,
            &Key::Reg(p),
            &Registration {
                valid_until,
                confirmed: false,
                withdrawn: false,
            },
        );
        unlock(&e);
    }
    pub fn leave(e: Env, p: Address) {
        p.require_auth();
        lock(&e);
        let c = cfg(&e);
        check(
            &e,
            phase(&e) <= 1 && now(&e) < c.calendar.registration_close,
            Error::Window,
        );
        let mut reg: Registration = e.storage().persistent().get(&Key::Reg(p.clone())).unwrap();
        check(&e, !reg.withdrawn, Error::Consumed);
        reg.withdrawn = true;
        let mut list: Vec<Address> = e.storage().instance().get(&Key::Registrations).unwrap();
        if let Some(index) = list.first_index_of(p.clone()) {
            list.remove(index);
        }
        e.storage().instance().set(&Key::Registrations, &list);
        store(&e, &Key::Reg(p), &reg);
        unlock(&e);
    }
    pub fn advance_reward(e: Env) -> i128 {
        let c = cfg(&e);
        let t = total(&e);
        let p = phase(&e);
        if p == 0 && now(&e) >= c.calendar.funding_close && activation_funded(&e, &c, &t) {
            return c.reward;
        }
        if p == 2 && now(&e) >= c.calendar.start || p == 3 && now(&e) >= c.calendar.end {
            return c.reward;
        }
        if p == 1 && now(&e) >= c.calendar.registration_close && now(&e) <= c.calendar.prepare_by {
            let frozen: Option<Vec<Address>> = e.storage().instance().get(&Key::Eligible);
            let count = if let Some(list) = frozen {
                list.len()
            } else {
                let list: Vec<Address> = e.storage().instance().get(&Key::Registrations).unwrap();
                let mut count = 0;
                for p in list.iter() {
                    let reg: Registration = e.storage().persistent().get(&Key::Reg(p)).unwrap();
                    if !reg.withdrawn && reg.valid_until >= now(&e) {
                        count += 1;
                    }
                }
                count
            };
            if count >= c.min_players {
                return c.reward;
            }
        }
        0
    }
    // Permissionless, deterministic registration order. Capital is assigned once at registration close.
    pub fn advance(e: Env, operator: Address) {
        operator.require_auth();
        lock(&e);
        let c = cfg(&e);
        let mut t = total(&e);
        let mut progressed = false;
        if phase(&e) == 0 && now(&e) >= c.calendar.funding_close {
            if !activation_funded(&e, &c, &t) {
                set_phase(&e, 6);
                unlock(&e);
                return;
            }
            set_phase(&e, 1);
            reward(&e, &operator, &mut t);
            progressed = true;
        }
        if phase(&e) == 1 && now(&e) >= c.calendar.registration_close {
            if now(&e) > c.calendar.prepare_by {
                set_phase(&e, 6);
                unlock(&e);
                return;
            }
            let eligible: Vec<Address> = if let Some(list) =
                e.storage().instance().get(&Key::Eligible)
            {
                list
            } else {
                let list: Vec<Address> = e.storage().instance().get(&Key::Registrations).unwrap();
                let mut eligible = Vec::new(&e);
                for p in list.iter() {
                    let reg: Registration =
                        e.storage().persistent().get(&Key::Reg(p.clone())).unwrap();
                    if !reg.withdrawn && reg.valid_until >= now(&e) {
                        eligible.push_back(p);
                    }
                }
                if eligible.len() < c.min_players {
                    set_phase(&e, 6);
                    unlock(&e);
                    return;
                }
                e.storage().instance().set(&Key::Eligible, &eligible);
                eligible
            };
            let prepared: u32 = e.storage().instance().get(&Key::Prepared).unwrap_or(0);
            let next = (prepared + 5).min(eligible.len());
            for i in prepared..next {
                let p = eligible.get(i).unwrap();
                let mut reg: Registration =
                    e.storage().persistent().get(&Key::Reg(p.clone())).unwrap();
                reg.confirmed = true;
                store(&e, &Key::Reg(p.clone()), &reg);
                store(
                    &e,
                    &Key::Player(p.clone()),
                    &Player {
                        settled: false,
                        claimed: false,
                        recovery: 0,
                        payout: 0,
                    },
                );
                credit(&e, &p, &c.cash, c.capital);
                t.players += 1;
                t.allocated += c.capital;
            }
            e.storage().instance().set(&Key::Prepared, &next);
            reward(&e, &operator, &mut t);
            if next == eligible.len() {
                t.capital -= t.allocated;
                set_phase(&e, 2);
            }
            progressed = true;
            put_total(&e, &t);
        }
        if phase(&e) == 2 && now(&e) >= c.calendar.start {
            set_phase(&e, 3);
            reward(&e, &operator, &mut t);
            progressed = true;
        }
        if phase(&e) == 3 && now(&e) >= c.calendar.end {
            set_phase(&e, 4);
            reward(&e, &operator, &mut t);
            progressed = true;
        }
        check(&e, progressed, Error::Pending);
        put_total(&e, &t);
        unlock(&e);
    }
    pub fn swap(
        e: Env,
        p: Address,
        sell: Address,
        buy: Address,
        n: i128,
        min_out: i128,
        adapter: Address,
    ) -> i128 {
        p.require_auth();
        lock(&e);
        is_trading(&e, buy != cfg(&e).cash);
        let _ = player(&e, &p);
        let out = swap(&e, &p, &sell, &buy, n, min_out, &adapter);
        unlock(&e);
        out
    }
    pub fn place_limit(
        e: Env,
        p: Address,
        sell: Address,
        buy: Address,
        n: i128,
        minimum: i128,
        expires: u64,
    ) -> u32 {
        p.require_auth();
        lock(&e);
        let c = cfg(&e);
        is_trading(&e, buy != c.cash);
        let _ = player(&e, &p);
        let mut t = total(&e);
        check(
            &e,
            c.assets.contains(&sell)
                && c.assets.contains(&buy)
                && sell != buy
                && n > 0
                && minimum > 0
                && now(&e) < expires
                && expires
                    <= if buy == c.cash {
                        c.calendar.end
                    } else {
                        c.calendar.risk_cutoff
                    },
            Error::NotAllowed,
        );
        check(
            &e,
            t.execution - t.fee_reserved
                >= c.reward * (3 + (t.players - t.settled) as i128 * c.assets.len() as i128),
            Error::Funds,
        );
        let mut ids = active_orders(&e, &p);
        check(&e, ids.len() < 10, Error::NotAllowed);
        let fee = premium(&e, &sell, &buy, n);
        credit(&e, &p, &sell, -n);
        credit(&e, &p, &c.cash, -fee);
        t.fee_reserved += c.reward;
        t.open_orders += 1;
        t.next_order += 1;
        ids.push_back(t.next_order);
        store(&e, &Key::PlayerOrders(p.clone()), &ids);
        let mut all: Vec<u32> = e
            .storage()
            .instance()
            .get(&Key::OpenOrders)
            .unwrap_or(Vec::new(&e));
        all.push_back(t.next_order);
        e.storage().instance().set(&Key::OpenOrders, &all);
        LimitEvent {
            id: t.next_order,
            player: p.clone(),
            sell: sell.clone(),
            buy: buy.clone(),
            amount: n,
            minimum,
            expires,
        }
        .publish(&e);
        store(
            &e,
            &Key::Order(t.next_order),
            &Order {
                player: p,
                sell,
                buy,
                amount: n,
                minimum,
                expires,
                open: true,
                premium: fee,
            },
        );
        put_total(&e, &t);
        unlock(&e);
        t.next_order
    }
    pub fn cancel_limit(e: Env, id: u32) {
        lock(&e);
        let mut o = Self::order(e.clone(), id);
        check(&e, o.open, Error::Consumed);
        if now(&e) < o.expires && now(&e) < cfg(&e).calendar.end {
            o.player.require_auth();
        }
        credit(&e, &o.player, &o.sell, o.amount);
        credit(&e, &o.player, &cfg(&e).cash, o.premium);
        remove_order(&e, id, &o.player);
        o.open = false;
        OrderEndEvent {
            id,
            player: o.player.clone(),
            filled: false,
        }
        .publish(&e);
        store(&e, &Key::Order(id), &o);
        let mut t = total(&e);
        t.fee_reserved -= cfg(&e).reward;
        t.open_orders -= 1;
        put_total(&e, &t);
        unlock(&e);
    }
    pub fn fill_limit(e: Env, id: u32, adapter: Address, operator: Address) -> i128 {
        operator.require_auth();
        lock(&e);
        let mut o = Self::order(e.clone(), id);
        is_trading(&e, o.buy != cfg(&e).cash);
        check(&e, o.open && now(&e) < o.expires, Error::Consumed);
        credit(&e, &o.player, &o.sell, o.amount);
        credit(&e, &o.player, &cfg(&e).cash, o.premium);
        let out = swap(
            &e, &o.player, &o.sell, &o.buy, o.amount, o.minimum, &adapter,
        );
        o.open = false;
        remove_order(&e, id, &o.player);
        OrderEndEvent {
            id,
            player: o.player.clone(),
            filled: true,
        }
        .publish(&e);
        store(&e, &Key::Order(id), &o);
        let mut t = total(&e);
        t.fee_reserved -= cfg(&e).reward;
        t.open_orders -= 1;
        reward(&e, &operator, &mut t);
        put_total(&e, &t);
        unlock(&e);
        out
    }
    pub fn expire_limits(e: Env, ids: Vec<u32>, operator: Address) {
        operator.require_auth();
        lock(&e);
        check(&e, !ids.is_empty() && ids.len() <= 20, Error::NotAllowed);
        let c = cfg(&e);
        let mut t = total(&e);
        for id in ids.iter() {
            let mut o = Self::order(e.clone(), id);
            check(
                &e,
                o.open && (now(&e) >= o.expires || now(&e) >= c.calendar.end),
                Error::Window,
            );
            credit(&e, &o.player, &o.sell, o.amount);
            credit(&e, &o.player, &c.cash, o.premium);
            remove_order(&e, id, &o.player);
            o.open = false;
            store(&e, &Key::Order(id), &o);
            OrderEndEvent {
                id,
                player: o.player,
                filled: false,
            }
            .publish(&e);
            t.fee_reserved -= c.reward;
            t.open_orders -= 1;
            reward(&e, &operator, &mut t);
        }
        put_total(&e, &t);
        unlock(&e);
    }
    pub fn close_buyout(e: Env, p: Address, asset: Address, operator: Address) -> i128 {
        operator.require_auth();
        lock(&e);
        let c = cfg(&e);
        let mut t = total(&e);
        check(
            &e,
            phase(&e) == 4
                && now(&e) >= c.calendar.settle_by
                && t.open_orders == 0
                && !player(&e, &p).settled
                && asset != c.cash,
            Error::State,
        );
        let key = Key::Receipt(p.clone(), asset.clone());
        let vault: Address = e.storage().persistent().get(&key).unwrap();
        let info = ReceiptClient::new(&e, &vault).info();
        let n = balance(&e, &p, &asset);
        check(
            &e,
            info.active
                && info.units == n
                && n > 0
                && info.controller == e.current_contract_address(),
            Error::State,
        );
        let before = token::Client::new(&e, &c.cash).balance(&e.current_contract_address());
        let promised = FacilityClient::new(&e, &facility(&e)).purchase(&vault);
        let received =
            token::Client::new(&e, &c.cash).balance(&e.current_contract_address()) - before;
        check(&e, received == promised, Error::Funds);
        credit(&e, &p, &asset, -n);
        credit(&e, &p, &c.cash, received);
        let residual = Residual {
            owner: c.exit.terms().unwrap().clone().provider,
            asset,
            units: n,
            claimed: false,
        };
        store(&e, &Key::Residual(vault), &residual);
        e.storage().persistent().remove(&key);
        reward(&e, &operator, &mut t);
        put_total(&e, &t);
        unlock(&e);
        received
    }
    pub fn withdraw_residual(e: Env, vault: Address) -> i128 {
        vault.require_auth();
        lock(&e);
        let key = Key::Residual(vault.clone());
        let mut residual: Residual = e.storage().persistent().get(&key).unwrap();
        check(&e, !residual.claimed, Error::Consumed);
        check(
            &e,
            wasm_hash(&e, &vault) == cfg(&e).exit.terms().unwrap().artifacts.spot_receipt_wasm,
            Error::State,
        );
        // The authenticated immutable receipt is the capability. Calling it back here
        // would re-enter redeem, which Soroban correctly rejects. The payee and units
        // were fixed atomically when that receipt was purchased.
        residual.claimed = true;
        store(&e, &key, &residual);
        // Pay only the owner recorded at purchase. A frozen external asset may still reject recovery.
        token::Client::new(&e, &residual.asset).transfer(
            &e.current_contract_address(),
            &residual.owner,
            &residual.units,
        );
        unlock(&e);
        residual.units
    }
    pub fn close_swap(
        e: Env,
        p: Address,
        sell: Address,
        min_out: i128,
        adapter: Address,
        operator: Address,
    ) -> i128 {
        operator.require_auth();
        lock(&e);
        check(
            &e,
            phase(&e) == 4 && now(&e) >= cfg(&e).calendar.end && !player(&e, &p).settled,
            Error::State,
        );
        let n = balance(&e, &p, &sell);
        let out = swap(&e, &p, &sell, &cfg(&e).cash, n, min_out, &adapter);
        let mut t = total(&e);
        reward(&e, &operator, &mut t);
        put_total(&e, &t);
        unlock(&e);
        out
    }
    pub fn settle_player(e: Env, p: Address, operator: Address) {
        operator.require_auth();
        lock(&e);
        let c = cfg(&e);
        let mut t = total(&e);
        check(&e, phase(&e) == 4 && t.open_orders == 0, Error::State);
        let mut pl = player(&e, &p);
        check(&e, !pl.settled, Error::Consumed);
        for a in c.assets.iter() {
            if a != c.cash {
                check(&e, balance(&e, &p, &a) == 0, Error::Pending);
            }
        }
        let recovery = balance(&e, &p, &c.cash);
        let gain = (recovery - c.capital).max(0);
        pl.payout = I256::from_i128(&e, gain)
            .mul(&I256::from_i128(&e, c.share_bps as i128))
            .div(&I256::from_i128(&e, 10000))
            .to_i128()
            .unwrap();
        pl.recovery = recovery;
        pl.settled = true;
        t.sponsor += recovery - pl.payout;
        t.settled += 1;
        credit(&e, &p, &c.cash, -recovery);
        // Ties use committed registration order, independent of keeper transaction order.
        if recovery > t.best_recovery {
            t.best_recovery = recovery;
            t.prize_winner = Some(p.clone());
        } else if recovery == t.best_recovery {
            let list: Vec<Address> = e.storage().instance().get(&Key::Registrations).unwrap();
            let winner = t.prize_winner.clone().unwrap();
            if list.first_index_of(p.clone()).unwrap() < list.first_index_of(winner).unwrap() {
                t.prize_winner = Some(p.clone());
            }
        }
        SettledEvent {
            player: p.clone(),
            recovery: pl.recovery,
            payout: pl.payout,
        }
        .publish(&e);
        store(&e, &Key::Player(p), &pl);
        reward(&e, &operator, &mut t);
        put_total(&e, &t);
        unlock(&e);
    }
    pub fn finalize(e: Env, operator: Address) {
        operator.require_auth();
        lock(&e);
        let mut t = total(&e);
        check(
            &e,
            phase(&e) == 4 && t.settled == t.players && t.open_orders == 0,
            Error::Pending,
        );
        if let Some(winner) = t.prize_winner.clone() {
            let mut p = player(&e, &winner);
            p.payout += t.prizes;
            t.prizes = 0;
            store(&e, &Key::Player(winner), &p);
        }
        set_phase(&e, 5);
        reward(&e, &operator, &mut t);
        put_total(&e, &t);
        unlock(&e);
    }
    pub fn claim(e: Env, beneficiary: Address) -> i128 {
        lock(&e);
        check(&e, phase(&e) == 5, Error::State);
        let mut p = player(&e, &beneficiary);
        check(&e, !p.claimed, Error::Consumed);
        p.claimed = true;
        store(&e, &Key::Player(beneficiary.clone()), &p);
        pay(&e, &beneficiary, p.payout);
        unlock(&e);
        p.payout
    }
    pub fn refund(e: Env, id: u32) -> i128 {
        lock(&e);
        let c = cfg(&e);
        if phase(&e) <= 1
            && (now(&e) > c.calendar.prepare_by
                || (phase(&e) == 0
                    && now(&e) >= c.calendar.funding_close
                    && !activation_funded(&e, &c, &total(&e))))
        {
            set_phase(&e, 6);
        }
        check(&e, phase(&e) == 6, Error::State);
        let mut x: Contribution = e
            .storage()
            .persistent()
            .get(&Key::Contribution(id))
            .unwrap();
        check(&e, !x.claimed, Error::Consumed);
        x.claimed = true;
        store(&e, &Key::Contribution(id), &x);
        let mut t = total(&e);
        let pending: i128 = e
            .storage()
            .persistent()
            .get(&Key::Weight(x.bucket))
            .unwrap();
        store(&e, &Key::Weight(x.bucket), &(pending - x.amount));
        let payout = if x.bucket == 2 {
            I256::from_i128(&e, t.execution)
                .mul(&I256::from_i128(&e, x.amount))
                .div(&I256::from_i128(&e, pending))
                .to_i128()
                .unwrap()
        } else {
            x.amount
        };
        if x.bucket == 0 {
            t.capital -= payout
        } else if x.bucket == 1 {
            t.prizes -= payout
        } else {
            t.execution -= payout
        };
        put_total(&e, &t);
        pay(&e, &x.owner, payout);
        unlock(&e);
        payout
    }
    // Sponsor principal and unused budgets return pro rata per deposit; last claimant receives dust.
    pub fn sponsor_claim(e: Env, id: u32) -> i128 {
        lock(&e);
        check(&e, phase(&e) == 5, Error::State);
        let mut x: Contribution = e
            .storage()
            .persistent()
            .get(&Key::Contribution(id))
            .unwrap();
        check(&e, !x.claimed, Error::Consumed);
        let mut t = total(&e);
        let pending: i128 = e
            .storage()
            .persistent()
            .get(&Key::Weight(x.bucket))
            .unwrap();
        store(&e, &Key::Weight(x.bucket), &(pending - x.amount));
        let pool = if x.bucket == 0 {
            t.capital + t.sponsor
        } else if x.bucket == 1 {
            t.prizes
        } else {
            t.execution
        };
        let payout = I256::from_i128(&e, pool)
            .mul(&I256::from_i128(&e, x.amount))
            .div(&I256::from_i128(&e, pending))
            .to_i128()
            .unwrap();
        if x.bucket == 0 {
            let from = t.sponsor.min(payout);
            t.sponsor -= from;
            t.capital -= payout - from;
        } else if x.bucket == 1 {
            t.prizes -= payout
        } else {
            t.execution -= payout
        };
        x.claimed = true;
        store(&e, &Key::Contribution(id), &x);
        put_total(&e, &t);
        pay(&e, &x.owner, payout);
        unlock(&e);
        payout
    }
    pub fn keepalive(e: Env) {
        touch(&e);
    }
    pub fn keep_player(e: Env, p: Address) {
        let target = e.storage().max_ttl();
        let keys = Vec::from_array(&e, [Key::Reg(p.clone()), Key::Player(p.clone())]);
        for k in keys.iter() {
            if e.storage().persistent().has(&k) {
                e.storage().persistent().extend_ttl(&k, target / 2, target);
            }
        }
        for a in cfg(&e).assets.iter() {
            let k = Key::Balance(p.clone(), a);
            if e.storage().persistent().has(&k) {
                e.storage().persistent().extend_ttl(&k, target / 2, target);
            }
        }
        touch(&e);
    }
    pub fn keep_order(e: Env, id: u32) {
        let target = e.storage().max_ttl();
        e.storage()
            .persistent()
            .extend_ttl(&Key::Order(id), target / 2, target);
        touch(&e);
    }
    pub fn keep_deposit(e: Env, id: u32) {
        let target = e.storage().max_ttl();
        e.storage()
            .persistent()
            .extend_ttl(&Key::Contribution(id), target / 2, target);
        for bucket in 0..3 {
            let key = Key::Weight(bucket);
            if e.storage().persistent().has(&key) {
                e.storage()
                    .persistent()
                    .extend_ttl(&key, target / 2, target);
            }
        }
        touch(&e);
    }
}
#[cfg(test)]
mod test;
