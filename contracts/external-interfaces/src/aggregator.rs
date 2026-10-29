// Wire interface verified against aggregator WASM hash 437653282e9c93b0b4d736d8fde01bf002adefb61bfb75917e609f5336ee3190.
// Implementation code is neither imported nor redistributed by this crate.
#[soroban_sdk::contractclient(name = "Client")]
pub trait Aggregator {
    fn config(e: soroban_sdk::Env) -> Config;
    fn swap_exact_in(
        e: soroban_sdk::Env,
        user: soroban_sdk::Address,
        token_in: soroban_sdk::Address,
        amount_in: i128,
        token_out: soroban_sdk::Address,
        min_out: i128,
        routes: soroban_sdk::Vec<Route>,
        partner: Option<Partner>,
    ) -> i128;
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct Config {
    pub admin: soroban_sdk::Address,
    pub aqua_router: soroban_sdk::Address,
    pub min_partner_bps: u32,
    pub paused: bool,
    pub pend_admin: Option<soroban_sdk::Address>,
    pub protocol_bps: u32,
    pub soroswap_router: soroban_sdk::Address,
    pub treasury: soroban_sdk::Address,
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct Route {
    pub amount_in: i128,
    pub hops: soroban_sdk::Vec<Hop>,
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct AquaHop {
    pub steps: soroban_sdk::Vec<(
        soroban_sdk::Vec<soroban_sdk::Address>,
        soroban_sdk::BytesN<32>,
        soroban_sdk::Address,
    )>,
    pub token_in: soroban_sdk::Address,
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct Partner {
    pub bps: u32,
    pub id: soroban_sdk::Symbol,
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct CometHop {
    pub pool: soroban_sdk::Address,
    pub token_in: soroban_sdk::Address,
    pub token_out: soroban_sdk::Address,
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct SushiHop {
    pub pool: soroban_sdk::Address,
    pub token_in: soroban_sdk::Address,
    pub token_out: soroban_sdk::Address,
    pub zero_for_one: bool,
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct PhoenixHop {
    pub pool: soroban_sdk::Address,
    pub token_in: soroban_sdk::Address,
    pub token_out: soroban_sdk::Address,
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct SoroswapHop {
    pub pair: soroban_sdk::Address,
    pub token_in: soroban_sdk::Address,
    pub token_out: soroban_sdk::Address,
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub enum DataKey {
    Config,
}
#[soroban_sdk::contracttype]
#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub enum Hop {
    Soroswap(SoroswapHop),
    Aqua(AquaHop),
    Sushi(SushiHop),
    Phoenix(PhoenixHop),
    Comet(CometHop),
}
