use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    IntoVal,
};
const CID: &str = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn authorize<'a>(
    e: &Env,
    id: &Address,
    owner: &Address,
    nickname: &String,
    cid: &String,
    revision: u32,
) {
    e.mock_auths(&[MockAuth {
        address: owner,
        invoke: &MockAuthInvoke {
            contract: id,
            fn_name: "set_profile",
            args: (owner.clone(), nickname.clone(), cid.clone(), revision).into_val(e),
            sub_invokes: &[],
        },
    }]);
}
#[test]
fn exact_wallet_consent_is_required_and_profiles_cannot_be_reassigned() {
    let e = Env::default();
    let id = e.register(PlayerProfile, ());
    let c = PlayerProfileClient::new(&e, &id);
    let owner = Address::generate(&e);
    let stranger = Address::generate(&e);
    let name = String::from_str(&e, "Orion Trader");
    let cid = String::from_str(&e, CID);
    assert!(c.get(&owner).is_none());
    assert!(c.try_set_profile(&owner, &name, &cid, &0).is_err());
    authorize(&e, &id, &owner, &name, &cid, 0);
    let profile = c.set_profile(&owner, &name, &cid, &0);
    assert_eq!(profile.owner, owner);
    assert_eq!(profile.revision, 1);
    assert_eq!(c.get(&owner), Some(profile.clone()));
    authorize(&e, &id, &stranger, &name, &cid, 1);
    assert!(c.try_set_profile(&owner, &name, &cid, &1).is_err());
    assert_eq!(c.get(&owner), Some(profile));
}
#[test]
fn stale_edits_cannot_overwrite_a_newer_avatar_and_names_need_not_be_unique() {
    let e = Env::default();
    let id = e.register(PlayerProfile, ());
    let c = PlayerProfileClient::new(&e, &id);
    let owner = Address::generate(&e);
    let other = Address::generate(&e);
    let name = String::from_str(&e, "Luna");
    let cid = String::from_str(&e, CID);
    authorize(&e, &id, &owner, &name, &cid, 0);
    c.set_profile(&owner, &name, &cid, &0);
    authorize(&e, &id, &other, &name, &cid, 0);
    c.set_profile(&other, &name, &cid, &0);
    let next = String::from_str(&e, "Luna 2");
    let empty = String::from_str(&e, "");
    authorize(&e, &id, &owner, &next, &empty, 0);
    assert!(c.try_set_profile(&owner, &next, &empty, &0).is_err());
    e.ledger().with_mut(|l| l.timestamp = 100);
    authorize(&e, &id, &owner, &next, &empty, 1);
    let updated = c.set_profile(&owner, &next, &empty, &1);
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.updated_at, 100);
    assert!(updated.avatar_cid.is_empty());
    assert_eq!(c.get(&other).unwrap().nickname, name);
}
#[test]
fn canonical_content_identifiers_and_bounded_display_names_are_enforced() {
    let e = Env::default();
    for value in ["", CID] {
        assert!(valid_avatar(&String::from_str(&e, value)));
    }
    for value in [
        "https://example.com/a.png",
        "ipfs://bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",
        "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
        "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA",
    ] {
        assert!(
            !valid_avatar(&String::from_str(&e, value)),
            "invalid CID accepted"
        );
    }
    for value in ["A", "Trader_7", "Moon Dog-1.2"] {
        assert!(valid_nickname(&String::from_str(&e, value)));
    }
    for value in [
        "",
        " A",
        "A ",
        "<script>",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "Möon",
    ] {
        assert!(!valid_nickname(&String::from_str(&e, value)));
    }
}
#[test]
fn anyone_can_renew_storage_without_gaining_edit_authority() {
    use soroban_sdk::testutils::storage::Persistent;
    let e = Env::default();
    let id = e.register(PlayerProfile, ());
    let c = PlayerProfileClient::new(&e, &id);
    let owner = Address::generate(&e);
    let name = String::from_str(&e, "Nova");
    let cid = String::from_str(&e, "");
    assert!(!c.keepalive(&owner));
    authorize(&e, &id, &owner, &name, &cid, 0);
    let profile = c.set_profile(&owner, &name, &cid, &0);
    e.ledger().with_mut(|l| l.sequence_number += 70000);
    let before = e.as_contract(&id, || {
        e.storage()
            .persistent()
            .get_ttl(&Key::Profile(owner.clone()))
    });
    e.mock_auths(&[]);
    assert!(c.keepalive(&owner));
    let after = e.as_contract(&id, || {
        e.storage()
            .persistent()
            .get_ttl(&Key::Profile(owner.clone()))
    });
    assert!(after > before);
    assert_eq!(c.get(&owner), Some(profile));
    assert!(c.try_set_profile(&owner, &name, &cid, &1).is_err());
}

#[test]
fn public_batch_reads_preserve_requested_order_and_bound_the_footprint() {
    let e = Env::default();
    let id = e.register(PlayerProfile, ());
    let c = PlayerProfileClient::new(&e, &id);
    let owner = Address::generate(&e);
    let missing = Address::generate(&e);
    let name = String::from_str(&e, "Star");
    let cid = String::from_str(&e, "");
    authorize(&e, &id, &owner, &name, &cid, 0);
    let p = c.set_profile(&owner, &name, &cid, &0);
    e.mock_auths(&[]);
    let out = c.get_many(&soroban_sdk::vec![&e, missing, owner.clone()]);
    assert_eq!(out.get(0), Some(None));
    assert_eq!(out.get(1), Some(Some(p)));
    let mut owners = Vec::new(&e);
    for _ in 0..21 {
        owners.push_back(owner.clone());
    }
    assert!(c.try_get_many(&owners).is_err());
}
