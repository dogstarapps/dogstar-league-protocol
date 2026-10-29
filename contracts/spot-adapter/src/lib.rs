#![no_std]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, token, vec, Address, BytesN, Env, Executable, IntoVal,
    Symbol, Vec, I256,
};

use aggregator::{Hop, Route};
pub use dogstar_external_interfaces::aggregator;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PairRoute {
    pub sell: Address,
    pub buy: Address,
    pub hops: Vec<Hop>,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterConfig {
    pub aggregator: Address,
    pub aggregator_hash: BytesN<32>,
    pub max_fee_bps: u32,
    pub routes: Vec<PairRoute>,
}
#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    SoroswapRouter,
    AquaRouter,
    Lock,
}
#[contract]
pub struct SpotAdapter;

fn touch(e: &Env) {
    let ttl = e.storage().max_ttl();
    e.storage().instance().extend_ttl(ttl / 2, ttl);
}
fn hop_pair(hop: &Hop) -> (Address, Address) {
    match hop {
        Hop::Soroswap(h) => (h.token_in.clone(), h.token_out.clone()),
        Hop::Sushi(h) => (h.token_in.clone(), h.token_out.clone()),
        Hop::Aqua(h) => {
            assert!(!h.steps.is_empty(), "empty_aqua_steps");
            let mut input = h.token_in.clone();
            for step in h.steps.iter() {
                assert!(
                    step.0.contains(&input) && step.0.contains(&step.2) && input != step.2,
                    "invalid_aqua_assets"
                );
                input = step.2;
            }
            (h.token_in.clone(), input)
        }
        _ => panic!("unsupported_venue"),
    }
}

#[contractimpl]
impl SpotAdapter {
    pub fn __constructor(e: Env, c: AdapterConfig) {
        assert!(
            c.max_fee_bps <= 1000 && !c.routes.is_empty() && c.routes.len() <= 32,
            "invalid_config"
        );
        assert!(
            c.aggregator.executable() == Some(Executable::Wasm(c.aggregator_hash.clone())),
            "aggregator_code_mismatch"
        );
        let mut pairs = Vec::<(Address, Address)>::new(&e);
        for route in c.routes.iter() {
            assert!(
                route.sell != route.buy && !route.hops.is_empty() && route.hops.len() <= 4,
                "invalid_route"
            );
            let pair = (route.sell.clone(), route.buy.clone());
            assert!(!pairs.contains(&pair), "duplicate_pair");
            pairs.push_back(pair);
            let mut input = route.sell.clone();
            for hop in route.hops.iter() {
                let (sell, buy) = hop_pair(&hop);
                assert!(input == sell && sell != buy, "disconnected_hop");
                input = buy;
            }
            assert!(input == route.buy, "wrong_route_output");
        }
        let config = aggregator::Client::new(&e, &c.aggregator).config();
        assert!(config.protocol_bps <= c.max_fee_bps, "fee_above_cap");
        e.storage()
            .instance()
            .set(&Key::SoroswapRouter, &config.soroswap_router);
        e.storage()
            .instance()
            .set(&Key::AquaRouter, &config.aqua_router);
        e.storage().instance().set(&Key::Config, &c);
        touch(&e);
    }

    pub fn config(e: Env) -> AdapterConfig {
        touch(&e);
        e.storage().instance().get(&Key::Config).unwrap()
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
        assert!(amount > 0 && minimum > 0 && sell != buy, "invalid_swap");
        assert!(
            !e.storage().instance().get(&Key::Lock).unwrap_or(false),
            "reentrant"
        );
        e.storage().instance().set(&Key::Lock, &true);
        let c = Self::config(e.clone());
        assert!(
            c.aggregator.executable() == Some(Executable::Wasm(c.aggregator_hash.clone())),
            "aggregator_code_mismatch"
        );
        let client = aggregator::Client::new(&e, &c.aggregator);
        let config = client.config();
        let soroswap_router: Address = e.storage().instance().get(&Key::SoroswapRouter).unwrap();
        let aqua_router: Address = e.storage().instance().get(&Key::AquaRouter).unwrap();
        assert!(
            !config.paused && config.protocol_bps <= c.max_fee_bps,
            "aggregator_paused_or_fee"
        );
        assert!(
            config.soroswap_router == soroswap_router && config.aqua_router == aqua_router,
            "router_changed"
        );
        let route = c
            .routes
            .iter()
            .find(|r| r.sell == sell && r.buy == buy)
            .expect("unapproved_pair");
        let fee = I256::from_i128(&e, amount)
            .mul(&I256::from_i128(&e, config.protocol_bps as i128))
            .div(&I256::from_i128(&e, 10000))
            .to_i128()
            .unwrap();
        let net = amount.checked_sub(fee).unwrap();
        assert!(net > 0, "fee_exhausts_input");
        let me = e.current_contract_address();
        let input = token::Client::new(&e, &sell);
        let output = token::Client::new(&e, &buy);
        let before_in = input.balance(&me);
        let before_out = output.balance(&me);
        assert!(
            before_in >= amount && recipient != me && recipient != c.aggregator,
            "input_or_recipient"
        );
        e.authorize_as_current_contract(vec![
            &e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: sell.clone(),
                    fn_name: Symbol::new(&e, "transfer"),
                    args: (me.clone(), c.aggregator.clone(), amount).into_val(&e),
                },
                sub_invocations: vec![&e],
            }),
        ]);
        client.swap_exact_in(
            &me,
            &sell,
            &amount,
            &buy,
            &minimum,
            &vec![
                &e,
                Route {
                    amount_in: net,
                    hops: route.hops,
                },
            ],
            &None,
        );
        let received = output
            .balance(&me)
            .checked_sub(before_out)
            .expect("output_underflow");
        assert!(
            before_in.checked_sub(input.balance(&me)) == Some(amount),
            "input_delta"
        );
        assert!(received >= minimum, "insufficient_net_output");
        output.transfer(&me, &recipient, &received);
        e.storage().instance().set(&Key::Lock, &false);
        touch(&e);
    }
}

#[cfg(test)]
mod test;
