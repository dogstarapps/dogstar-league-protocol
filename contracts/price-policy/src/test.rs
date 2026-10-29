use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec,
};

#[contract]
struct Feed;
#[contractimpl]
impl Feed {
    pub fn base(e: Env) -> Asset {
        Asset::Other(Symbol::new(&e, "USD"))
    }
    pub fn decimals(_e: Env) -> u32 {
        14
    }
    pub fn lastprice(e: Env, asset: Asset) -> Option<PriceData> {
        e.storage().persistent().get(&asset)
    }
    pub fn set(e: Env, asset: Asset, price: i128, timestamp: u64) {
        e.storage()
            .persistent()
            .set(&asset, &PriceData { price, timestamp });
    }
}
fn hash(address: &Address) -> BytesN<32> {
    match address.executable().unwrap() {
        Executable::Wasm(h) => h,
        _ => panic!("not_wasm"),
    }
}
struct Setup {
    e: Env,
    id: Address,
    feed: Address,
    a: Address,
    b: Address,
}
fn setup() -> Setup {
    let e = Env::default();
    e.ledger().with_mut(|l| l.timestamp = 1000);
    let admin = Address::generate(&e);
    let a = e
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let b = e.register_stellar_asset_contract_v2(admin).address();
    let feed = e.register(Feed, ());
    let client = FeedClient::new(&e, &feed);
    client.set(&Asset::Stellar(a.clone()), &200_00000000000000, &990);
    client.set(&Asset::Stellar(b.clone()), &100_00000000000000, &990);
    let c = PolicyConfig {
        oracle: feed.clone(),
        oracle_hash: hash(&feed),
        max_age: 30,
        max_skew: 10,
        slippage_bps: 100,
        feeds: vec![
            &e,
            TokenFeed {
                token: a.clone(),
                asset: Asset::Stellar(a.clone()),
                decimals: 7,
            },
            TokenFeed {
                token: b.clone(),
                asset: Asset::Stellar(b.clone()),
                decimals: 7,
            },
        ],
    };
    let id = e.register(PricePolicy, (c,));
    Setup { e, id, feed, a, b }
}
#[test]
fn independent_cross_price_with_large_amounts() {
    let s = setup();
    let c = PricePolicyClient::new(&s.e, &s.id);
    assert_eq!(c.minimum(&s.a, &s.b, &10_0000000), 19_8000000);
    let amount = 1_000_000_000_000_000_000_000_000i128;
    assert_eq!(c.minimum(&s.a, &s.b, &amount), amount * 198 / 100);
    // The oracle unit cancels; no assumption that a token is worth one dollar.
    assert_eq!(c.minimum(&s.b, &s.a, &10_0000000), 4_9500000);
}
#[test]
fn missing_stale_future_zero_and_skewed_quotes_fail_closed() {
    let s = setup();
    let c = PricePolicyClient::new(&s.e, &s.id);
    let f = FeedClient::new(&s.e, &s.feed);
    for (price, timestamp) in [(100, 969), (100, 1001), (0, 990), (-1, 990), (100, 970)] {
        f.set(&Asset::Stellar(s.a.clone()), &price, &timestamp);
        assert!(c.try_minimum(&s.a, &s.b, &10_0000000).is_err());
    }
    assert!(c.try_minimum(&Address::generate(&s.e), &s.b, &10).is_err());
    assert!(c.try_minimum(&s.a, &s.a, &10).is_err());
}
#[test]
#[should_panic(expected = "token_decimals")]
fn actual_token_decimals_are_checked_at_creation() {
    let s = setup();
    let mut c = PricePolicyClient::new(&s.e, &s.id).config();
    let mut feed = c.feeds.get(0).unwrap();
    feed.decimals = 6;
    c.feeds.set(0, feed);
    s.e.register(PricePolicy, (c,));
}
