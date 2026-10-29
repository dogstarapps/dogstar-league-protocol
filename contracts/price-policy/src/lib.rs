#![no_std]
// Renew a bounded seven-day lease at the nominal five-second ledger cadence.
// Archived entries remain restorable; never prepay the network maximum on each write.

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, Address, BytesN, Env, Executable,
    Symbol, Vec, I256,
};

// SEP-40 wire types. Every mapped token is priced by the same feed and base.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}
#[contractclient(name = "OracleClient")]
pub trait Oracle {
    fn base(e: Env) -> Asset;
    fn decimals(e: Env) -> u32;
    fn lastprice(e: Env, asset: Asset) -> Option<PriceData>;
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenFeed {
    pub token: Address,
    pub asset: Asset,
    pub decimals: u32,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyConfig {
    pub oracle: Address,
    pub oracle_hash: BytesN<32>,
    pub max_age: u64,
    pub max_skew: u64,
    pub slippage_bps: u32,
    pub feeds: Vec<TokenFeed>,
}
#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    Base,
    Decimals,
}
#[contract]
pub struct PricePolicy;

fn touch(e: &Env) {
    let ttl = e.storage().max_ttl().min(120_960);
    e.storage().instance().extend_ttl(ttl / 2, ttl);
}
fn mapped(c: &PolicyConfig, token: &Address) -> TokenFeed {
    c.feeds
        .iter()
        .find(|f| f.token == *token)
        .expect("unmapped_token")
}
fn fresh(e: &Env, c: &PolicyConfig, p: &PriceData) {
    let now = e.ledger().timestamp();
    assert!(p.price > 0 && p.timestamp <= now, "invalid_price");
    assert!(now - p.timestamp <= c.max_age, "stale_price");
}

#[contractimpl]
impl PricePolicy {
    pub fn __constructor(e: Env, c: PolicyConfig) {
        assert!(
            c.max_age > 0 && c.max_skew <= c.max_age,
            "invalid_freshness"
        );
        assert!(c.slippage_bps <= 1000, "slippage_limit");
        assert!(c.feeds.len() >= 2 && c.feeds.len() <= 32, "feed_count");
        assert!(
            c.oracle.executable() == Some(Executable::Wasm(c.oracle_hash.clone())),
            "oracle_code_mismatch"
        );
        let client = OracleClient::new(&e, &c.oracle);
        let decimals = client.decimals();
        assert!(decimals <= 38, "oracle_decimals");
        let mut seen = Vec::new(&e);
        for feed in c.feeds.iter() {
            assert!(!seen.contains(&feed.token), "duplicate_token");
            assert!(
                feed.decimals <= 18
                    && token::Client::new(&e, &feed.token).decimals() == feed.decimals,
                "token_decimals"
            );
            seen.push_back(feed.token);
        }
        e.storage().instance().set(&Key::Config, &c);
        e.storage().instance().set(&Key::Base, &client.base());
        e.storage().instance().set(&Key::Decimals, &decimals);
        touch(&e);
    }

    pub fn config(e: Env) -> PolicyConfig {
        touch(&e);
        e.storage().instance().get(&Key::Config).unwrap()
    }

    pub fn minimum(e: Env, sell: Address, buy: Address, amount: i128) -> i128 {
        assert!(sell != buy && amount > 0, "invalid_pair_amount");
        let c = Self::config(e.clone());
        assert!(
            c.oracle.executable() == Some(Executable::Wasm(c.oracle_hash.clone())),
            "oracle_code_mismatch"
        );
        let client = OracleClient::new(&e, &c.oracle);
        let base: Asset = e.storage().instance().get(&Key::Base).unwrap();
        let decimals: u32 = e.storage().instance().get(&Key::Decimals).unwrap();
        assert!(
            client.base() == base && client.decimals() == decimals,
            "oracle_unit_changed"
        );
        let sell_feed = mapped(&c, &sell);
        let buy_feed = mapped(&c, &buy);
        assert!(
            token::Client::new(&e, &sell).decimals() == sell_feed.decimals
                && token::Client::new(&e, &buy).decimals() == buy_feed.decimals,
            "token_unit_changed"
        );
        let a = client
            .lastprice(&sell_feed.asset)
            .expect("missing_sell_price");
        let b = client
            .lastprice(&buy_feed.asset)
            .expect("missing_buy_price");
        fresh(&e, &c, &a);
        fresh(&e, &c, &b);
        assert!(
            a.timestamp.abs_diff(b.timestamp) <= c.max_skew,
            "price_time_skew"
        );
        // I256 operations trap on overflow; values never wrap or become a cheaper quote.
        let expected = I256::from_i128(&e, amount)
            .mul(&I256::from_i128(&e, a.price))
            .mul(&I256::from_i128(&e, 10i128.pow(buy_feed.decimals)))
            .div(&I256::from_i128(&e, b.price))
            .div(&I256::from_i128(&e, 10i128.pow(sell_feed.decimals)));
        let minimum = expected
            .mul(&I256::from_i128(&e, (10000 - c.slippage_bps) as i128))
            .div(&I256::from_i128(&e, 10000))
            .to_i128()
            .expect("quote_overflow");
        assert!(minimum > 0, "dust_quote");
        minimum
    }
}

#[cfg(test)]
mod test;
