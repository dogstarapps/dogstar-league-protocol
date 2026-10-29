#![no_std]
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contractimpl, contracttype, token, vec, Address, BytesN, Env,
    Executable, IntoVal, Symbol, Vec,
};
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectSettings {
    pub router: Address,
    pub router_hash: BytesN<32>,
    pub factory: Address,
    pub factory_hash: BytesN<32>,
    pub pair: Address,
    pub pair_hash: BytesN<32>,
    pub asset0: Address,
    pub asset1: Address,
}
#[contractclient(name = "RouterClient")]
pub trait Router {
    fn get_factory(e: Env) -> Address;
    fn router_get_amounts_out(e: Env, amount_in: i128, path: Vec<Address>) -> Vec<i128>;
    fn swap_exact_tokens_for_tokens(
        e: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
}
#[contractclient(name = "FactoryClient")]
pub trait Factory {
    fn get_pair(e: Env, token_a: Address, token_b: Address) -> Address;
}
#[contractclient(name = "PairClient")]
pub trait Pair {
    fn token_0(e: Env) -> Address;
    fn token_1(e: Env) -> Address;
}
#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    Lock,
}
#[contract]
pub struct DirectSwap;
fn config(e: &Env) -> DirectSettings {
    e.storage().instance().get(&Key::Config).unwrap()
}
fn check_hash(address: &Address, hash: &BytesN<32>) {
    assert!(
        address.executable() == Some(Executable::Wasm(hash.clone())),
        "external_code_changed"
    );
}
fn verify(e: &Env, c: &DirectSettings) {
    check_hash(&c.router, &c.router_hash);
    check_hash(&c.factory, &c.factory_hash);
    check_hash(&c.pair, &c.pair_hash);
    assert!(
        RouterClient::new(e, &c.router).get_factory() == c.factory
            && FactoryClient::new(e, &c.factory).get_pair(&c.asset0, &c.asset1) == c.pair,
        "route_mismatch"
    );
    let pair = PairClient::new(e, &c.pair);
    assert!(
        pair.token_0() == c.asset0 && pair.token_1() == c.asset1,
        "asset_mismatch"
    );
}
fn allowed(c: &DirectSettings, sell: &Address, buy: &Address) -> bool {
    (*sell == c.asset0 && *buy == c.asset1) || (*sell == c.asset1 && *buy == c.asset0)
}
fn touch(e: &Env) {
    let n = e.storage().max_ttl().min(120_960);
    e.storage().instance().extend_ttl(n / 2, n);
}
#[contractimpl]
impl DirectSwap {
    pub fn __constructor(e: Env, c: DirectSettings) {
        assert!(c.asset0 != c.asset1, "distinct_assets_required");
        verify(&e, &c);
        e.storage().instance().set(&Key::Config, &c);
        touch(&e);
    }
    pub fn config(e: Env) -> DirectSettings {
        config(&e)
    }
    pub fn capabilities() -> u32 {
        dogstar_protocol_types::CAP_SPOT
    }
    // This is a venue quote. The round/vault separately enforces its independent policy.
    pub fn quote(e: Env, sell: Address, buy: Address, amount: i128) -> i128 {
        let c = config(&e);
        assert!(allowed(&c, &sell, &buy) && amount > 0, "unsupported_quote");
        verify(&e, &c);
        let result =
            RouterClient::new(&e, &c.router).router_get_amounts_out(&amount, &vec![&e, sell, buy]);
        assert!(
            result.len() == 2 && result.get(0).unwrap() == amount,
            "invalid_quote"
        );
        result.get(1).unwrap()
    }
    pub fn swap(
        e: Env,
        sell: Address,
        buy: Address,
        amount: i128,
        minimum: i128,
        recipient: Address,
    ) {
        recipient.require_auth();
        assert!(
            !e.storage().instance().get(&Key::Lock).unwrap_or(false),
            "reentrant"
        );
        e.storage().instance().set(&Key::Lock, &true);
        let c = config(&e);
        assert!(
            allowed(&c, &sell, &buy) && amount > 0 && minimum > 0,
            "unsupported_swap"
        );
        verify(&e, &c);
        let me = e.current_contract_address();
        let input = token::Client::new(&e, &sell);
        let output = token::Client::new(&e, &buy);
        let before_input = input.balance(&me);
        let before_output = output.balance(&me);
        let before_recipient = output.balance(&recipient);
        assert!(before_input >= amount, "prepaid_input_required");
        e.authorize_as_current_contract(vec![
            &e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: sell.clone(),
                    fn_name: Symbol::new(&e, "transfer"),
                    args: (me.clone(), c.pair.clone(), amount).into_val(&e),
                },
                sub_invocations: vec![&e],
            }),
        ]);
        let report = RouterClient::new(&e, &c.router).swap_exact_tokens_for_tokens(
            &amount,
            &minimum,
            &vec![&e, sell, buy],
            &me,
            &e.ledger().timestamp().checked_add(120).unwrap(),
        );
        let received = output.balance(&me) - before_output;
        assert!(
            before_input - input.balance(&me) == amount
                && received >= minimum
                && report.len() == 2
                && report.get(0).unwrap() == amount
                && report.get(1).unwrap() == received,
            "swap_delta"
        );
        output.transfer(&me, &recipient, &received);
        assert!(
            output.balance(&recipient) - before_recipient == received,
            "recipient_delta"
        );
        e.storage().instance().set(&Key::Lock, &false);
        touch(&e);
    }
    pub fn keepalive(e: Env) {
        touch(&e);
    }
}
#[cfg(test)]
mod test;
