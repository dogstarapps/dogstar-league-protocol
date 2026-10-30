#![no_std]
use dogstar_protocol_types::ReceiptInfo;
pub use dogstar_zenex_types::{
    CloseRequest, MarketClient, OpenRequest, TraderState, VaultContext, ZenexSettings,
};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contractimpl, contracttype, token, vec,
    xdr::FromXdr,
    Address, Bytes, Env, Executable, IntoVal, Symbol, TryFromVal, I256,
};
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
    BeforeSettlement,
    Baseline,
    Observed,
    Idle,
    Spent,
    Long,
    Lock,
}
#[contract]
pub struct ZenexVault;
#[contractclient(name = "SwapClient")]
pub trait Swap {
    fn swap(e: Env, sell: Address, buy: Address, amount: i128, minimum: i128, recipient: Address);
}
#[contractclient(name = "QuoteClient")]
pub trait Quote {
    fn minimum(e: Env, sell: Address, buy: Address, amount: i128) -> i128;
}
fn settings(e: &Env) -> ZenexSettings {
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
fn verify(e: &Env) {
    let s = settings(e);
    let c = context(e);
    for (address, hash) in [
        (s.market.clone(), s.market_hash),
        (s.swap_adapter, s.swap_hash),
        (c.quote_policy, c.quote_hash),
    ] {
        assert!(
            address.executable() == Some(Executable::Wasm(hash)),
            "external_code_changed"
        );
    }
    assert!(
        MarketClient::new(e, &s.market).get_token() == s.settlement,
        "settlement_asset_changed"
    );
}
fn state(e: &Env) -> TraderState {
    let s = settings(e);
    let p = MarketClient::new(e, &s.market).get_trader_state(&e.current_contract_address());
    assert!(
        p.version == 1
            && p.paid >= 0
            && p.credit >= 0
            && p.long_notional >= 0
            && p.short_notional >= 0,
        "invalid_venue_accounting"
    );
    p
}
fn checked_state(e: &Env) -> TraderState {
    let p = state(e);
    let before: TraderState = e.storage().instance().get(&Key::Baseline).unwrap();
    let observed: TraderState = e.storage().instance().get(&Key::Observed).unwrap();
    assert!(
        p.epoch == before.epoch && p.sequence >= observed.sequence && p.paid >= observed.paid,
        "venue_accounting_reset"
    );
    e.storage().instance().set(&Key::Observed, &p);
    p
}
fn fee(e: &Env) -> i128 {
    let s = settings(e);
    let cfg = MarketClient::new(e, &s.market).get_config();
    let v = cfg
        .get(Symbol::new(e, "exec_fee"))
        .expect("missing_execution_fee");
    let n = i128::try_from_val(e, &v).expect("invalid_execution_fee");
    assert!(n >= 0, "negative_fee");
    n
}
fn authorize(e: &Env, n: i128) {
    let s = settings(e);
    e.authorize_as_current_contract(vec![
        e,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: s.settlement,
                fn_name: Symbol::new(e, "transfer"),
                args: (e.current_contract_address(), s.market, n).into_val(e),
            },
            sub_invocations: vec![e],
        }),
    ]);
}
fn convert(e: &Env, sell: &Address, buy: &Address, n: i128, min: i128) -> i128 {
    assert!(n >= 0 && min >= 0, "invalid_conversion");
    if sell == buy {
        assert!(n >= min, "minimum_not_met");
        return n;
    }
    if n == 0 {
        assert!(min == 0, "minimum_not_met");
        return 0;
    }
    let c = context(e);
    let s = settings(e);
    let floor = QuoteClient::new(e, &c.quote_policy).minimum(sell, buy, &n);
    assert!(floor > 0, "invalid_price_floor");
    let me = e.current_contract_address();
    let out = token::Client::new(e, buy);
    let before = out.balance(&me);
    token::Client::new(e, sell).transfer(&me, &s.swap_adapter, &n);
    SwapClient::new(e, &s.swap_adapter).swap(sell, buy, &n, &floor.max(min), &me);
    let delta = out.balance(&me) - before;
    assert!(delta >= floor.max(min), "conversion_delta");
    delta
}
#[contractimpl]
impl ZenexVault {
    pub fn __constructor(e: Env, s: ZenexSettings, c: VaultContext) {
        assert!(
            s.cash == c.cash
                && c.basis > 0
                && c.round != c.player
                && c.round != c.facility
                && matches!(c.round.executable(), Some(Executable::Wasm(_))),
            "invalid_context"
        );
        assert!(
            s.max_leverage_bps >= 10000
                && s.max_leverage_bps <= 1_000_000
                && s.close_fee_reserve >= 0,
            "invalid_risk_limits"
        );
        let me = e.current_contract_address();
        e.storage().instance().set(
            &Key::BeforeCash,
            &token::Client::new(&e, &s.cash).balance(&me),
        );
        e.storage().instance().set(
            &Key::BeforeSettlement,
            &token::Client::new(&e, &s.settlement).balance(&me),
        );
        e.storage().instance().set(&Key::Settings, &s);
        e.storage().instance().set(&Key::Context, &c);
        e.storage().instance().set(&Key::Owner, &c.round);
        e.storage().instance().set(&Key::Active, &false);
        e.storage().instance().set(&Key::Initialized, &false);
        e.storage().instance().set(&Key::Units, &0i128);
        e.storage().instance().set(&Key::Spent, &0i128);
        verify(&e);
        let initial = state(&e);
        assert!(
            initial.pending_orders == 0
                && initial.long_notional == 0
                && initial.short_notional == 0
                && initial.credit == 0,
            "nonempty_external_account"
        );
        e.storage().instance().set(&Key::Baseline, &initial);
        e.storage().instance().set(&Key::Observed, &initial);
        touch(&e);
    }
    pub fn controller(e: Env) -> Address {
        e.storage().instance().get(&Key::Owner).unwrap()
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
            asset: s.settlement,
            units: e.storage().instance().get(&Key::Units).unwrap_or(0),
            basis: c.basis,
            active: e.storage().instance().get(&Key::Active).unwrap_or(false),
        }
    }
    pub fn initialize(e: Env, minimums: soroban_sdk::Vec<i128>, request: Bytes) {
        let c = context(&e);
        let s = settings(&e);
        c.adapter.require_auth();
        enter(&e);
        assert!(
            !e.storage()
                .instance()
                .get(&Key::Initialized)
                .unwrap_or(false)
                && minimums.len() == 2,
            "invalid_initialization"
        );
        verify(&e);
        let r = OpenRequest::from_xdr(&e, &request).expect("invalid_open_request");
        assert!(
            !r.price.is_empty() && r.price.len() <= 12000 && r.price_bound > 0 && r.notional > 0,
            "bounded_open_required"
        );
        let me = e.current_contract_address();
        let before: i128 = e.storage().instance().get(&Key::BeforeCash).unwrap();
        assert!(
            token::Client::new(&e, &s.cash).balance(&me) - before == c.basis,
            "exact_cash_input_required"
        );
        let total = convert(
            &e,
            &s.cash,
            &s.settlement,
            c.basis,
            minimums.get(0).unwrap(),
        );
        let execution = fee(&e);
        assert!(
            s.close_fee_reserve >= execution,
            "closing_fee_reserve_required"
        );
        let margin = total
            .checked_sub(execution)
            .unwrap()
            .checked_sub(s.close_fee_reserve)
            .unwrap();
        assert!(
            margin > 0 && margin >= minimums.get(1).unwrap(),
            "insufficient_margin"
        );
        assert!(
            I256::from_i128(&e, r.notional).mul(&I256::from_i128(&e, 10000))
                <= I256::from_i128(&e, margin)
                    .mul(&I256::from_i128(&e, s.max_leverage_bps as i128)),
            "leverage_limit"
        );
        authorize(&e, margin.checked_add(execution).unwrap());
        let market = MarketClient::new(&e, &s.market);
        let id = market.create_order(
            &me,
            &r.is_long,
            &0,
            &r.notional,
            &margin,
            &0,
            &r.price_bound,
            &e.ledger().sequence().checked_add(1).unwrap(),
        );
        market.execute_order(&market.get_treasury(), &me, &id, &r.price);
        let p = checked_state(&e);
        assert!(
            p.pending_orders == 0
                && (if r.is_long {
                    p.long_notional == r.notional && p.short_notional == 0
                } else {
                    p.short_notional == r.notional && p.long_notional == 0
                }),
            "atomic_fill_required"
        );
        let baseline: i128 = e.storage().instance().get(&Key::BeforeSettlement).unwrap();
        let idle = token::Client::new(&e, &s.settlement).balance(&me) - baseline;
        assert!(idle == s.close_fee_reserve, "exact_margin_escrow_required");
        e.storage().instance().set(&Key::Idle, &idle);
        e.storage().instance().set(&Key::Long, &r.is_long);
        e.storage().instance().set(&Key::Units, &r.notional);
        e.storage().instance().set(&Key::Initialized, &true);
        e.storage().instance().set(&Key::Active, &true);
        leave(&e);
    }
    pub fn native_exit(e: Env, min_cash: i128, request: Bytes) -> i128 {
        let c = context(&e);
        let s = settings(&e);
        let owner = Self::controller(e.clone());
        owner.require_auth();
        enter(&e);
        assert!(
            e.storage().instance().get(&Key::Active).unwrap_or(false) && min_cash >= 0,
            "invalid_exit"
        );
        verify(&e);
        let me = e.current_contract_address();
        let market = MarketClient::new(&e, &s.market);
        let mut p = checked_state(&e);
        let is_long: bool = e.storage().instance().get(&Key::Long).unwrap();
        assert!(p.pending_orders == 0, "unexpected_pending_orders");
        let open = if is_long {
            p.long_notional
        } else {
            p.short_notional
        };
        assert!(
            if is_long {
                p.short_notional == 0
            } else {
                p.long_notional == 0
            },
            "unexpected_opposing_position"
        );
        if open > 0 {
            let r = CloseRequest::from_xdr(&e, &request).expect("signed_close_price_required");
            assert!(
                !r.price.is_empty() && r.price.len() <= 12000 && r.price_bound >= 0,
                "invalid_close_report"
            );
            let execution = fee(&e);
            authorize(&e, execution);
            let id = market.create_order(
                &me,
                &is_long,
                &3,
                &i128::MAX,
                &0,
                &0,
                &r.price_bound,
                &e.ledger().sequence().checked_add(1).unwrap(),
            );
            market.execute_order(&market.get_treasury(), &me, &id, &r.price);
            e.storage().instance().set(&Key::Spent, &execution);
            p = checked_state(&e);
        }
        if p.credit > 0 {
            market.claim_credit(&me);
            p = checked_state(&e);
        }
        assert!(
            p.long_notional == 0 && p.short_notional == 0 && p.pending_orders == 0 && p.credit == 0,
            "settlement_incomplete"
        );
        let baseline: TraderState = e.storage().instance().get(&Key::Baseline).unwrap();
        let idle: i128 = e.storage().instance().get(&Key::Idle).unwrap();
        let spent: i128 = e.storage().instance().get(&Key::Spent).unwrap_or(0);
        let tracked = idle
            .checked_add(p.paid - baseline.paid)
            .unwrap()
            .checked_sub(spent)
            .unwrap();
        let available = token::Client::new(&e, &s.settlement).balance(&me);
        let amount = if owner == c.round {
            assert!(
                tracked >= 0 && available >= tracked,
                "venue_cash_not_received"
            );
            tracked
        } else {
            available
        };
        let cash = convert(&e, &s.settlement, &s.cash, amount, min_cash);
        assert!(cash >= min_cash, "minimum_cash_not_met");
        let recipient = if owner == c.round {
            e.storage().instance().set(&Key::Owner, &c.player);
            c.round
        } else {
            owner
        };
        e.storage().instance().set(&Key::Active, &false);
        e.storage().instance().set(&Key::Units, &0i128);
        if cash > 0 {
            token::Client::new(&e, &s.cash).transfer(&me, &recipient, &cash);
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
                && to != c.round
                && e.storage().instance().get(&Key::Active).unwrap_or(false),
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
        leave(&e);
        n
    }
    pub fn keepalive(e: Env) {
        touch(&e);
    }
}
