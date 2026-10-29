#![no_std]
// Renew a bounded seven-day lease at the nominal five-second ledger cadence.
// Archived entries remain restorable; never prepay the network maximum on each write.
use dogstar_external_interfaces::blend::{Client as PoolClient, Positions, Request};
use dogstar_protocol_types::ReceiptInfo;
pub use dogstar_vault_types::{BlendSettings, VaultContext};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contractimpl, contracttype, token, vec, Address, BytesN, Env,
    Executable, IntoVal, Symbol, Vec,
};
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
    Units,
    Initialized,
    Active,
    BeforeCash,
    BeforeUnderlying,
    Lock,
}
#[contract]
pub struct BlendVault;
fn settings(e: &Env) -> BlendSettings {
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
fn assert_hash(address: &Address, hash: &BytesN<32>) {
    assert!(
        address.executable() == Some(Executable::Wasm(hash.clone())),
        "external_code_changed"
    );
}
fn valid_positions(p: &Positions, index: u32) -> i128 {
    assert!(
        p.collateral.is_empty() && p.liabilities.is_empty() && p.supply.len() <= 1,
        "supply_only_position_required"
    );
    p.supply.get(index).unwrap_or(0)
}
fn convert(e: &Env, sell: &Address, buy: &Address, n: i128, minimum: i128) -> i128 {
    if n == 0 {
        return 0;
    }
    if sell == buy {
        assert!(n >= minimum, "minimum_cash_not_met");
        return n;
    }
    let c = context(e);
    let s = settings(e);
    assert_hash(&s.swap_adapter, &s.swap_hash);
    assert_hash(&c.quote_policy, &c.quote_hash);
    let floor = QuoteClient::new(e, &c.quote_policy).minimum(sell, buy, &n);
    let limit = minimum.max(floor);
    assert!(limit > 0, "invalid_quote");
    let me = e.current_contract_address();
    let before = token::Client::new(e, buy).balance(&me);
    token::Client::new(e, sell).transfer(&me, &s.swap_adapter, &n);
    SwapClient::new(e, &s.swap_adapter).swap(sell, buy, &n, &limit, &me);
    let received = token::Client::new(e, buy).balance(&me) - before;
    assert!(received >= limit, "swap_delta");
    received
}
#[contractimpl]
impl BlendVault {
    pub fn __constructor(e: Env, s: BlendSettings, c: VaultContext) {
        assert!(
            c.cash == s.cash && c.basis > 0 && c.round != c.player && c.round != c.facility,
            "invalid_vault_context"
        );
        assert!(
            matches!(c.round.executable(), Some(Executable::Wasm(_))),
            "round_must_be_contract"
        );
        assert_hash(&s.pool, &s.pool_hash);
        assert_hash(&s.swap_adapter, &s.swap_hash);
        assert_hash(&c.quote_policy, &c.quote_hash);
        let me = e.current_contract_address();
        e.storage().instance().set(
            &Key::BeforeCash,
            &token::Client::new(&e, &s.cash).balance(&me),
        );
        e.storage().instance().set(
            &Key::BeforeUnderlying,
            &token::Client::new(&e, &s.underlying).balance(&me),
        );
        e.storage().instance().set(&Key::Owner, &c.round);
        e.storage().instance().set(&Key::Context, &c);
        e.storage().instance().set(&Key::Settings, &s);
        e.storage().instance().set(&Key::Units, &0i128);
        e.storage().instance().set(&Key::Active, &false);
        e.storage().instance().set(&Key::Initialized, &false);
        touch(&e);
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
            asset: s.underlying,
            units: e.storage().instance().get(&Key::Units).unwrap(),
            basis: c.basis,
            active: e.storage().instance().get(&Key::Active).unwrap(),
        }
    }
    pub fn controller(e: Env) -> Address {
        e.storage().instance().get(&Key::Owner).unwrap()
    }
    pub fn initialize(e: Env, min_underlying: i128) {
        let c = context(&e);
        let s = settings(&e);
        c.adapter.require_auth();
        enter(&e);
        assert!(
            !e.storage()
                .instance()
                .get(&Key::Initialized)
                .unwrap_or(false),
            "already_initialized"
        );
        assert_hash(&s.pool, &s.pool_hash);
        let me = e.current_contract_address();
        let before: i128 = e.storage().instance().get(&Key::BeforeCash).unwrap();
        assert!(
            token::Client::new(&e, &c.cash).balance(&me) - before == c.basis,
            "exact_cash_input_required"
        );
        let amount = convert(&e, &c.cash, &s.underlying, c.basis, min_underlying);
        assert!(amount > 0, "positive_supply_required");
        let before_underlying = token::Client::new(&e, &s.underlying).balance(&me);
        e.authorize_as_current_contract(vec![
            &e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: s.underlying.clone(),
                    fn_name: Symbol::new(&e, "transfer"),
                    args: (me.clone(), s.pool.clone(), amount).into_val(&e),
                },
                sub_invocations: vec![&e],
            }),
        ]);
        let positions = PoolClient::new(&e, &s.pool).submit(
            &me,
            &me,
            &me,
            &vec![
                &e,
                Request {
                    address: s.underlying.clone(),
                    amount,
                    request_type: 0,
                },
            ],
        );
        assert!(
            before_underlying - token::Client::new(&e, &s.underlying).balance(&me) == amount,
            "supply_input_delta"
        );
        let shares = valid_positions(&positions, s.reserve_index);
        assert!(shares > 0, "missing_supply_shares");
        e.storage().instance().set(&Key::Units, &shares);
        e.storage().instance().set(&Key::Initialized, &true);
        e.storage().instance().set(&Key::Active, &true);
        leave(&e);
    }
    pub fn native_exit(e: Env, min_cash: i128) -> i128 {
        let c = context(&e);
        let s = settings(&e);
        let owner = Self::controller(e.clone());
        owner.require_auth();
        enter(&e);
        assert!(
            e.storage().instance().get(&Key::Active).unwrap_or(false) && min_cash >= 0,
            "position_closed"
        );
        assert_hash(&s.pool, &s.pool_hash);
        let me = e.current_contract_address();
        let underlying = token::Client::new(&e, &s.underlying);
        let before = underlying.balance(&me);
        let positions = PoolClient::new(&e, &s.pool).submit(
            &me,
            &me,
            &me,
            &vec![
                &e,
                Request {
                    address: s.underlying.clone(),
                    amount: i128::MAX,
                    request_type: 1,
                },
            ],
        );
        assert!(
            valid_positions(&positions, s.reserve_index) == 0,
            "partial_withdrawal_cannot_close"
        );
        let received = underlying.balance(&me) - before;
        assert!(received >= 0, "withdrawal_delta");
        let cash = convert(&e, &s.underlying, &c.cash, received, min_cash);
        assert!(cash >= min_cash, "minimum_cash_not_met");
        e.storage().instance().set(&Key::Active, &false);
        e.storage().instance().set(&Key::Units, &0i128);
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
        assert!(owner != c.round, "round_controls_open_position");
        let token = token::Client::new(&e, &asset);
        let n = token.balance(&e.current_contract_address());
        if n > 0 {
            token.transfer(&e.current_contract_address(), &owner, &n);
        }
        leave(&e);
        n
    }
    pub fn claim_incentives(e: Env, ids: Vec<u32>) -> i128 {
        let c = context(&e);
        let s = settings(&e);
        let owner = Self::controller(e.clone());
        owner.require_auth();
        enter(&e);
        assert!(
            owner != c.round && ids.len() <= 20,
            "round_controls_position"
        );
        assert_hash(&s.pool, &s.pool_hash);
        let n = PoolClient::new(&e, &s.pool).claim(&e.current_contract_address(), &ids, &owner);
        leave(&e);
        n
    }
    pub fn adopt_pool_code(e: Env) {
        let c = context(&e);
        let owner = Self::controller(e.clone());
        owner.require_auth();
        assert!(owner != c.round, "round_cannot_accept_upgrade");
        let mut s = settings(&e);
        s.pool_hash = match s.pool.executable() {
            Some(Executable::Wasm(h)) => h,
            _ => panic!("pool_must_be_contract"),
        };
        e.storage().instance().set(&Key::Settings, &s);
        touch(&e);
    }
    pub fn keepalive(e: Env) {
        touch(&e);
    }
}
