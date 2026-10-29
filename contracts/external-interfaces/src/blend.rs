// Interoperability declarations only. Blend pool ABI fetched read-only; see NOTICE.
use soroban_sdk::{contractclient, contracttype, Address, Env, Map, Vec};
#[contracttype(export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    pub address: Address,
    pub amount: i128,
    pub request_type: u32,
}
#[contracttype(export = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Positions {
    pub collateral: Map<u32, i128>,
    pub liabilities: Map<u32, i128>,
    pub supply: Map<u32, i128>,
}
#[contractclient(name = "Client")]
pub trait Pool {
    fn get_positions(e: Env, address: Address) -> Positions;
    fn submit(
        e: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions;
    fn claim(e: Env, from: Address, reserve_token_ids: Vec<u32>, to: Address) -> i128;
}
