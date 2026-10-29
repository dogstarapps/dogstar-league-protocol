use super::*;
use dogstar_external_interfaces::blend::{Positions, Request};
use dogstar_protocol_types::ReceiptInfo;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    IntoVal, Map, Vec,
};
const VAULT_WASM: &[u8] =
    include_bytes!("../../target/wasm32v1-none/release/dogstar_blend_vault.wasm");
#[contract]
struct Pool;
#[contractimpl]
impl Pool {
    pub fn __constructor(e: Env, asset: Address) {
        e.storage().instance().set(&0u32, &asset);
        e.storage().instance().set(&1u32, &2i128);
    }
    pub fn rate(e: Env, n: i128) {
        e.storage().instance().set(&1u32, &n);
    }
    pub fn freeze(e: Env, frozen: bool) {
        e.storage().instance().set(&2u32, &frozen);
    }
    pub fn get_positions(e: Env, address: Address) -> Positions {
        let shares: i128 = e.storage().persistent().get(&address).unwrap_or(0);
        let mut supply = Map::new(&e);
        if shares > 0 {
            supply.set(0u32, shares);
        }
        Positions {
            collateral: Map::new(&e),
            liabilities: Map::new(&e),
            supply,
        }
    }
    pub fn submit(
        e: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions {
        from.require_auth();
        spender.require_auth();
        to.require_auth();
        assert!(
            !e.storage().instance().get(&2u32).unwrap_or(false),
            "pool_frozen"
        );
        let asset: Address = e.storage().instance().get(&0u32).unwrap();
        let rate: i128 = e.storage().instance().get(&1u32).unwrap();
        for request in requests.iter() {
            assert!(request.address == asset, "wrong_asset");
            if request.request_type == 0 {
                token::Client::new(&e, &asset).transfer(
                    &spender,
                    &e.current_contract_address(),
                    &request.amount,
                );
                e.storage()
                    .persistent()
                    .set(&from, &(request.amount / rate));
            } else {
                assert!(
                    request.request_type == 1 && request.amount == i128::MAX,
                    "only_full_supply_withdrawal"
                );
                let shares: i128 = e.storage().persistent().get(&from).unwrap();
                token::Client::new(&e, &asset).transfer(
                    &e.current_contract_address(),
                    &to,
                    &(shares * rate),
                );
                e.storage().persistent().set(&from, &0i128);
            }
        }
        Self::get_positions(e, from)
    }
}
#[contract]
struct Quote;
#[contractimpl]
impl Quote {
    pub fn minimum(_e: Env, _sell: Address, _buy: Address, amount: i128) -> i128 {
        amount * 99 / 100
    }
}
#[contract]
struct Swap;
#[contractimpl]
impl Swap {
    pub fn ping() {}
}
#[contractclient(name = "ManagedClient")]
#[allow(dead_code)]
trait Managed {
    fn info(e: Env) -> ReceiptInfo;
    fn controller(e: Env) -> Address;
    fn native_exit(e: Env, min_cash: i128) -> i128;
    fn handover(e: Env, to: Address);
    fn recover(e: Env, asset: Address) -> i128;
}
#[contract]
struct Round;
#[contractimpl]
impl Round {
    pub fn open(
        e: Env,
        adapter: Address,
        player: Address,
        facility: Address,
        quote: Address,
        n: i128,
        nonce: u32,
    ) -> Address {
        let cfg = BlendAdapterClient::new(&e, &adapter).config();
        let quote_hash = match quote.executable() {
            Some(Executable::Wasm(h)) => h,
            _ => panic!("quote"),
        };
        let context = VaultContext {
            round: e.current_contract_address(),
            player,
            facility,
            adapter: adapter.clone(),
            cash: cfg.cash.clone(),
            basis: n,
            quote_policy: quote,
            quote_hash,
        };
        token::Client::new(&e, &cfg.cash).transfer(&e.current_contract_address(), &adapter, &n);
        BlendAdapterClient::new(&e, &adapter).open(&context, &nonce, &n)
    }
    pub fn close(e: Env, vault: Address) -> i128 {
        ManagedClient::new(&e, &vault).native_exit(&0)
    }
}
#[contract]
struct Facility;
#[contractimpl]
impl Facility {
    pub fn take(e: Env, vault: Address, to: Address) {
        ManagedClient::new(&e, &vault).handover(&to);
    }
}
struct Setup {
    e: Env,
    round: Address,
    pool: Address,
    adapter: Address,
    quote: Address,
    facility: Address,
    cash: Address,
    player: Address,
    provider: Address,
}
fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().with_mut(|l| l.timestamp = 10);
    let admin = Address::generate(&e);
    let cash = e.register_stellar_asset_contract_v2(admin).address();
    let pool = e.register(Pool, (cash.clone(),));
    let quote = e.register(Quote, ());
    let swap = e.register(Swap, ());
    let code = |address: &Address| match address.executable() {
        Some(Executable::Wasm(h)) => h,
        _ => panic!("code"),
    };
    let cfg = BlendSettings {
        cash: cash.clone(),
        underlying: cash.clone(),
        pool: pool.clone(),
        pool_hash: code(&pool),
        reserve_index: 0,
        swap_adapter: swap.clone(),
        swap_hash: code(&swap),
        vault_wasm: e.deployer().upload_contract_wasm(VAULT_WASM),
    };
    let adapter = e.register(BlendAdapter, (cfg,));
    let round = e.register(Round, ());
    let facility = e.register(Facility, ());
    let player = Address::generate(&e);
    let provider = Address::generate(&e);
    StellarAssetClient::new(&e, &cash).mint(&round, &1000);
    StellarAssetClient::new(&e, &cash).mint(&pool, &10000);
    e.mock_auths(&[]);
    Setup {
        e,
        round,
        pool,
        adapter,
        quote,
        facility,
        cash,
        player,
        provider,
    }
}
#[test]
fn actual_b_shares_and_withdrawal_deltas_preserve_yield_without_global_auth_bypass() {
    let s = setup();
    let round = RoundClient::new(&s.e, &s.round);
    let vault = round.open(&s.adapter, &s.player, &s.facility, &s.quote, &1000, &0);
    let info = ManagedClient::new(&s.e, &vault).info();
    assert_eq!(info.units, 500);
    assert_eq!(info.basis, 1000);
    PoolClient::new(&s.e, &s.pool).rate(&3);
    assert_eq!(round.close(&vault), 1500);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.round), 1500);
    let info = ManagedClient::new(&s.e, &vault).info();
    assert!(!info.active);
    assert_eq!(info.controller, s.player);
    assert!(round.try_close(&vault).is_err());
}
#[test]
fn frozen_pool_cannot_block_local_handover_and_recovery_uses_new_controller() {
    let s = setup();
    let round = RoundClient::new(&s.e, &s.round);
    let vault = round.open(&s.adapter, &s.player, &s.facility, &s.quote, &1000, &0);
    PoolClient::new(&s.e, &s.pool).freeze(&true);
    assert!(round.try_close(&vault).is_err());
    FacilityClient::new(&s.e, &s.facility).take(&vault, &s.provider);
    let managed = ManagedClient::new(&s.e, &vault);
    assert_eq!(managed.controller(), s.provider);
    assert!(round.try_close(&vault).is_err());
    PoolClient::new(&s.e, &s.pool).freeze(&false);
    s.e.mock_auths(&[MockAuth {
        address: &s.provider,
        invoke: &MockAuthInvoke {
            contract: &vault,
            fn_name: "native_exit",
            args: (0i128,).into_val(&s.e),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(managed.native_exit(&0), 1000);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.provider), 1000);
}
#[test]
fn donated_idle_cash_is_returned_separately_and_cannot_inflate_competition_return() {
    let s = setup();
    let round = RoundClient::new(&s.e, &s.round);
    let vault = round.open(&s.adapter, &s.player, &s.facility, &s.quote, &1000, &0);
    s.e.mock_all_auths();
    StellarAssetClient::new(&s.e, &s.cash).mint(&vault, &500);
    s.e.mock_auths(&[]);
    assert_eq!(round.close(&vault), 1000);
    assert_eq!(token::Client::new(&s.e, &s.cash).balance(&s.round), 1000);
    s.e.mock_auths(&[MockAuth {
        address: &s.player,
        invoke: &MockAuthInvoke {
            contract: &vault,
            fn_name: "recover",
            args: (s.cash.clone(),).into_val(&s.e),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(ManagedClient::new(&s.e, &vault).recover(&s.cash), 500);
}
