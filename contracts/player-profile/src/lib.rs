#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Profile {
    pub owner: Address,
    pub nickname: String,
    pub avatar_cid: String,
    pub revision: u32,
    pub updated_at: u64,
}
#[contracttype]
#[derive(Clone)]
enum Key {
    Profile(Address),
}
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidNickname = 1,
    InvalidAvatar = 2,
    RevisionConflict = 3,
    BatchTooLarge = 4,
}
#[contractevent]
#[derive(Clone)]
pub struct ProfileUpdated {
    #[topic]
    pub owner: Address,
    pub revision: u32,
    pub nickname: String,
    pub avatar_cid: String,
}
#[contract]
pub struct PlayerProfile;
fn renew(e: &Env, key: &Key) {
    let target = e.storage().max_ttl().min(120_960);
    e.storage().persistent().extend_ttl(key, target / 2, target);
    e.storage().instance().extend_ttl(target / 2, target);
}
fn alphanumeric(c: u8) -> bool {
    c.is_ascii_alphanumeric()
}
fn valid_nickname(name: &String) -> bool {
    let n = name.len() as usize;
    if n == 0 || n > 32 {
        return false;
    }
    let mut bytes = [0u8; 32];
    name.copy_into_slice(&mut bytes[..n]);
    alphanumeric(bytes[0])
        && alphanumeric(bytes[n - 1])
        && bytes[..n]
            .iter()
            .all(|c| alphanumeric(*c) || matches!(*c, b' ' | b'_' | b'-' | b'.'))
}
// Canonical CIDv1, raw codec, sha2-256: b + unpadded lower-case base32 of 36 bytes.
// Raw image blocks let clients verify the exact avatar bytes without trusting a gateway.
fn valid_avatar(cid: &String) -> bool {
    if cid.is_empty() {
        return true;
    }
    if cid.len() != 59 {
        return false;
    }
    let mut text = [0u8; 59];
    cid.copy_into_slice(&mut text);
    if text[0] != b'b' {
        return false;
    }
    let mut decoded = [0u8; 36];
    let mut acc = 0u32;
    let mut bits = 0u32;
    let mut index = 0usize;
    for c in &text[1..] {
        let value = match c {
            b'a'..=b'z' => c - b'a',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return false,
        };
        acc = (acc << 5) | value as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if index >= 36 {
                return false;
            }
            decoded[index] = (acc >> bits) as u8;
            index += 1;
            acc &= (1 << bits) - 1;
        }
    }
    index == 36 && acc == 0 && decoded[..4] == [1, 0x55, 0x12, 0x20]
}
#[contractimpl]
impl PlayerProfile {
    pub fn version() -> u32 {
        1
    }
    pub fn get(e: Env, owner: Address) -> Option<Profile> {
        e.storage().persistent().get(&Key::Profile(owner))
    }
    pub fn get_many(e: Env, owners: Vec<Address>) -> Vec<Option<Profile>> {
        soroban_sdk::assert_with_error!(&e, owners.len() <= 20, Error::BatchTooLarge);
        let mut out = Vec::new(&e);
        for owner in owners.iter() {
            out.push_back(Self::get(e.clone(), owner));
        }
        out
    }
    pub fn set_profile(
        e: Env,
        owner: Address,
        nickname: String,
        avatar_cid: String,
        expected_revision: u32,
    ) -> Profile {
        owner.require_auth();
        soroban_sdk::assert_with_error!(&e, valid_nickname(&nickname), Error::InvalidNickname);
        soroban_sdk::assert_with_error!(&e, valid_avatar(&avatar_cid), Error::InvalidAvatar);
        let key = Key::Profile(owner.clone());
        let old: Option<Profile> = e.storage().persistent().get(&key);
        let current = old.map(|p| p.revision).unwrap_or(0);
        soroban_sdk::assert_with_error!(&e, current == expected_revision, Error::RevisionConflict);
        let profile = Profile {
            owner: owner.clone(),
            nickname: nickname.clone(),
            avatar_cid: avatar_cid.clone(),
            revision: current.checked_add(1).unwrap(),
            updated_at: e.ledger().timestamp(),
        };
        e.storage().persistent().set(&key, &profile);
        renew(&e, &key);
        ProfileUpdated {
            owner,
            revision: profile.revision,
            nickname,
            avatar_cid,
        }
        .publish(&e);
        profile
    }
    pub fn keepalive(e: Env, owner: Address) -> bool {
        let key = Key::Profile(owner);
        if !e.storage().persistent().has(&key) {
            return false;
        }
        renew(&e, &key);
        true
    }
}
#[cfg(test)]
mod test;
