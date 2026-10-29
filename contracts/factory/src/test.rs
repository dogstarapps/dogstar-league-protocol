use super::*;
use dogstar_protocol_types::{Calendar, ExitPolicy, ExitTerms};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    vec, IntoVal,
};

// The verification command builds this WASM from the current locked sources first.
const ROUND_WASM: &[u8] =
    include_bytes!("../../target/wasm32v1-none/release/dogstar_tournament.wasm");
#[contract]
struct RegistryFixture;
#[contractimpl]
impl RegistryFixture {
    pub fn __constructor(e: Env, p: ProtocolVersion) {
        e.storage().instance().set(&0u32, &p);
    }
    pub fn get(e: Env, id: Symbol, version: u32) -> ProtocolVersion {
        let p: ProtocolVersion = e.storage().instance().get(&0u32).unwrap();
        assert!(p.id == id && p.version == version);
        p
    }
    pub fn available(e: Env, id: Symbol, version: u32) -> bool {
        let p: ProtocolVersion = e.storage().instance().get(&0u32).unwrap();
        p.id == id && p.version == version && !e.storage().instance().get(&1u32).unwrap_or(false)
    }
    pub fn pause(e: Env) {
        e.storage().instance().set(&1u32, &true);
    }
}
#[contract]
struct Policy;
#[contractimpl]
impl Policy {
    pub fn minimum(_e: Env, _sell: Address, _buy: Address, amount: i128) -> i128 {
        amount
    }
}
#[contract]
struct Adapter;
#[contractimpl]
impl Adapter {
    pub fn capabilities() -> u32 {
        1
    }
    pub fn ping() {}
}
#[contractclient(name = "RoundClient")]
#[allow(dead_code)]
trait RoundViews {
    fn terms(e: Env) -> BytesN<32>;
    fn config(e: Env) -> Config;
}
struct Setup {
    e: Env,
    factory: Address,
    registry: Address,
    c: Config,
    selections: Vec<ProtocolSelection>,
}
fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().with_mut(|l| l.timestamp = 10);
    let creator = Address::generate(&e);
    let cash = e
        .register_stellar_asset_contract_v2(creator.clone())
        .address();
    let policy = e.register(Policy, ());
    let adapter = e.register(Adapter, ());
    let hash = match adapter.executable().unwrap() {
        soroban_sdk::Executable::Wasm(h) => h,
        _ => panic!("not_wasm"),
    };
    let p = ProtocolVersion {
        id: Symbol::new(&e, "spot"),
        version: 1,
        adapter: adapter.clone(),
        wasm_hash: hash,
        capabilities: 1,
        metadata_hash: BytesN::from_array(&e, &[1; 32]),
    };
    let registry = e.register(RegistryFixture, (p,));
    let wasm = e.deployer().upload_contract_wasm(ROUND_WASM);
    let artifacts = ExitArtifacts {
        facility_wasm: e.deployer().upload_contract_wasm(
            &include_bytes!("../../target/wasm32v1-none/release/dogstar_exit_facility.wasm")[..],
        ),
        spot_receipt_wasm: e.deployer().upload_contract_wasm(
            &include_bytes!("../../target/wasm32v1-none/release/dogstar_spot_receipt.wasm")[..],
        ),
    };
    let factory = e.register(
        Factory,
        (
            registry.clone(),
            wasm,
            policy.clone(),
            cash.clone(),
            artifacts.clone(),
        ),
    );
    let c = Config {
        creator: creator.clone(),
        cash: cash.clone(),
        assets: vec![&e, cash],
        adapters: vec![&e, adapter],
        quote_policy: policy,
        capital: 1000,
        min_players: 1,
        max_players: 2,
        share_bps: 10000,
        prizes: 100,
        execution: 100,
        reward: 1,
        exit: ExitPolicy::Covered(ExitTerms {
            provider: creator,
            fallback_bps: 10000,
            premium_bps: 0,
            minimum_coverage: 2000,
            artifacts,
        }),
        calendar: Calendar {
            funding_open: 1,
            funding_close: 20,
            registration_open: 1,
            registration_close: 30,
            prepare_by: 40,
            start: 50,
            risk_cutoff: 90,
            end: 100,
            settle_by: 120,
        },
    };
    let selections = vec![
        &e,
        ProtocolSelection {
            id: Symbol::new(&e, "spot"),
            version: 1,
        },
    ];
    Setup {
        e,
        factory,
        registry,
        c,
        selections,
    }
}
#[test]
fn deploys_actual_round_wasm_with_exact_terms_and_indexed_metadata() {
    let s = setup();
    let c = FactoryClient::new(&s.e, &s.factory);
    let salt = BytesN::from_array(&s.e, &[2; 32]);
    let metadata = BytesN::from_array(&s.e, &[3; 32]);
    let address = c.create(&s.c, &s.selections, &salt, &metadata);
    let round = RoundClient::new(&s.e, &address);
    let record = c.get(&0);
    assert_eq!(round.config(), s.c);
    assert_eq!(record.address, address);
    assert_eq!(record.config_hash, round.terms());
    assert_eq!(record.metadata_hash, metadata);
    assert_eq!(record.protocols.get(0).unwrap().version, 1);
    assert_eq!(c.count(), 1);
    assert_eq!(c.page(&0, &50).len(), 1);
    assert!(c.try_create(&s.c, &s.selections, &salt, &metadata).is_err());
    RegistryFixtureClient::new(&s.e, &s.registry).pause();
    assert_eq!(round.terms(), record.config_hash);
    assert!(c
        .try_create(
            &s.c,
            &s.selections,
            &BytesN::from_array(&s.e, &[4; 32]),
            &metadata
        )
        .is_err());
    assert_eq!(c.count(), 1);
}
#[test]
fn unauthorized_creator_unapproved_policy_and_mismatched_selection_fail() {
    let s = setup();
    let c = FactoryClient::new(&s.e, &s.factory);
    let salt = BytesN::from_array(&s.e, &[2; 32]);
    let metadata = BytesN::from_array(&s.e, &[3; 32]);
    let mut config = s.c.clone();
    config.quote_policy = Address::generate(&s.e);
    assert!(c
        .try_create(&config, &s.selections, &salt, &metadata)
        .is_err());
    assert!(c
        .try_create(&s.c, &Vec::new(&s.e), &salt, &metadata)
        .is_err());
    s.e.mock_auths(&[]);
    assert!(c.try_create(&s.c, &s.selections, &salt, &metadata).is_err());
    assert_eq!(c.count(), 0);
}
#[test]
fn creator_funding_is_atomic_and_requires_consent_for_all_three_budgets() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    let s = setup();
    let factory = FactoryClient::new(&s.e, &s.factory);
    let salt = BytesN::from_array(&s.e, &[8; 32]);
    let metadata = BytesN::from_array(&s.e, &[9; 32]);
    let deploy_salt: BytesN<32> =
        s.e.crypto()
            .sha256(&(s.c.creator.clone(), salt.clone()).to_xdr(&s.e))
            .into();
    let address = s.e.as_contract(&s.factory, || {
        s.e.deployer()
            .with_current_contract(deploy_salt)
            .deployed_address()
    });
    StellarAssetClient::new(&s.e, &s.c.cash).mint(&s.c.creator, &2200);
    let leaves = [
        MockAuthInvoke {
            contract: &s.c.cash,
            fn_name: "transfer",
            args: (s.c.creator.clone(), address.clone(), 2000i128).into_val(&s.e),
            sub_invokes: &[],
        },
        MockAuthInvoke {
            contract: &s.c.cash,
            fn_name: "transfer",
            args: (s.c.creator.clone(), address.clone(), 100i128).into_val(&s.e),
            sub_invokes: &[],
        },
        MockAuthInvoke {
            contract: &s.c.cash,
            fn_name: "transfer",
            args: (s.c.creator.clone(), address.clone(), 100i128).into_val(&s.e),
            sub_invokes: &[],
        },
    ];
    let calls = [
        MockAuthInvoke {
            contract: &address,
            fn_name: "__constructor",
            args: (s.c.clone(),).into_val(&s.e),
            sub_invokes: &[],
        },
        MockAuthInvoke {
            contract: &address,
            fn_name: "contribute",
            args: (s.c.creator.clone(), 0u32, 2000i128).into_val(&s.e),
            sub_invokes: &leaves[0..1],
        },
        MockAuthInvoke {
            contract: &address,
            fn_name: "contribute",
            args: (s.c.creator.clone(), 1u32, 100i128).into_val(&s.e),
            sub_invokes: &leaves[1..2],
        },
        MockAuthInvoke {
            contract: &address,
            fn_name: "contribute",
            args: (s.c.creator.clone(), 2u32, 100i128).into_val(&s.e),
            sub_invokes: &leaves[2..3],
        },
    ];
    s.e.mock_auths(&[MockAuth {
        address: &s.c.creator,
        invoke: &MockAuthInvoke {
            contract: &s.factory,
            fn_name: "create_funded",
            args: (
                s.c.clone(),
                s.selections.clone(),
                salt.clone(),
                metadata.clone(),
            )
                .into_val(&s.e),
            sub_invokes: &calls,
        },
    }]);
    assert_eq!(
        factory.create_funded(&s.c, &s.selections, &salt, &metadata),
        address
    );
    assert!(factory.get(&0).creator_funded);
    assert_eq!(
        soroban_sdk::token::Client::new(&s.e, &s.c.cash).balance(&address),
        2200
    );
    assert_eq!(
        soroban_sdk::token::Client::new(&s.e, &s.c.cash).balance(&s.c.creator),
        0
    );
    s.e.mock_all_auths();
    assert!(FundingClient::new(&s.e, &address)
        .try_contribute(&s.c.creator, &0, &1)
        .is_err());
}
#[test]
fn insufficient_creator_funding_rolls_back_creation_and_keeps_the_salt_reusable() {
    let s = setup();
    let factory = FactoryClient::new(&s.e, &s.factory);
    let salt = BytesN::from_array(&s.e, &[8; 32]);
    let metadata = BytesN::from_array(&s.e, &[9; 32]);
    StellarAssetClient::new(&s.e, &s.c.cash).mint(&s.c.creator, &2199);
    assert!(factory
        .try_create_funded(&s.c, &s.selections, &salt, &metadata)
        .is_err());
    assert_eq!(factory.count(), 0);
    assert_eq!(
        soroban_sdk::token::Client::new(&s.e, &s.c.cash).balance(&s.c.creator),
        2199
    );
    StellarAssetClient::new(&s.e, &s.c.cash).mint(&s.c.creator, &1);
    factory.create_funded(&s.c, &s.selections, &salt, &metadata);
    assert_eq!(factory.count(), 1);
}
