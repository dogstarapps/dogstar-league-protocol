use super::*;
use soroban_sdk::testutils::Address as _;

#[contract]
struct Adapter;
#[contractimpl]
impl Adapter {
    pub fn ping() {}
}
fn record(e: &Env) -> ProtocolVersion {
    let adapter = e.register(Adapter, ());
    let hash = match adapter.executable().unwrap() {
        Executable::Wasm(h) => h,
        _ => panic!("not_wasm"),
    };
    ProtocolVersion {
        id: Symbol::new(e, "sushi"),
        version: 1,
        adapter,
        wasm_hash: hash,
        capabilities: 1,
        metadata_hash: BytesN::from_array(e, &[7; 32]),
    }
}
#[test]
fn admission_is_authorized_versioned_paged_and_immutable() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let id = e.register(Registry, (admin.clone(),));
    let c = RegistryClient::new(&e, &id);
    let r = record(&e);
    c.admit(&r);
    assert_eq!(e.auths()[0].0, admin);
    assert_eq!(c.get(&r.id, &1), r);
    assert_eq!(c.count(), 1);
    assert_eq!(c.page(&0, &1), soroban_sdk::vec![&e, r.clone()]);
    assert!(c.page(&1, &50).is_empty());
    assert!(c.try_admit(&r).is_err());
    c.set_paused(&r.id, &1, &true);
    assert!(!c.available(&r.id, &1));
    assert_eq!(c.get(&r.id, &1), r);
    c.set_paused(&r.id, &1, &false);
    assert!(c.available(&r.id, &1));
    let mut invalid = r.clone();
    invalid.version = 2;
    invalid.wasm_hash = BytesN::from_array(&e, &[9; 32]);
    assert!(c.try_admit(&invalid).is_err());
    e.mock_auths(&[]);
    let mut next = r;
    next.version = 2;
    assert!(c.try_admit(&next).is_err());
    assert!(c.try_set_paused(&next.id, &1, &true).is_err());
    assert_eq!(c.count(), 1);
}
