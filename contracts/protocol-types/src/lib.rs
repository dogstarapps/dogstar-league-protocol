#![no_std]
use soroban_sdk::{contracttype, Address, Vec};
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Calendar {
    pub funding_open: u64,
    pub funding_close: u64,
    pub registration_open: u64,
    pub registration_close: u64,
    pub prepare_by: u64,
    pub start: u64,
    pub risk_cutoff: u64,
    pub end: u64,
    pub settle_by: u64,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub creator: Address,
    pub cash: Address,
    pub assets: Vec<Address>,
    pub adapters: Vec<Address>,
    pub quote_policy: Address,
    pub calendar: Calendar,
    pub capital: i128,
    pub min_players: u32,
    pub max_players: u32,
    pub share_bps: u32,
    pub prizes: i128,
    pub execution: i128,
    pub reward: i128,
    pub exit: ExitPolicy,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExitPolicy {
    CashOnly,
    Covered(ExitTerms),
}
impl ExitPolicy {
    pub fn terms(&self) -> Option<&ExitTerms> {
        match self {
            Self::CashOnly => None,
            Self::Covered(terms) => Some(terms),
        }
    }
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExitArtifacts {
    pub facility_wasm: BytesN<32>,
    pub spot_receipt_wasm: BytesN<32>,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExitTerms {
    pub provider: Address,
    pub fallback_bps: u32,
    pub premium_bps: u32,
    pub minimum_coverage: i128,
    pub artifacts: ExitArtifacts,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FacilityConfig {
    pub cash: Address,
    pub controller: Address,
    pub provider: Address,
    pub risk_cutoff: u64,
    pub purchase_at: u64,
    pub round_terms: BytesN<32>,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReceiptInfo {
    pub controller: Address,
    pub round: Address,
    pub facility: Address,
    pub player: Address,
    pub cash: Address,
    pub asset: Address,
    pub units: i128,
    pub basis: i128,
    pub active: bool,
}
use soroban_sdk::{BytesN, Symbol};
pub const CAP_SPOT: u32 = 1;
pub const CAP_LP: u32 = 2;
pub const CAP_SUPPLY: u32 = 4;
pub const CAP_PERP: u32 = 8;
pub const CAP_POSITION: u32 = 16;
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolVersion {
    pub id: Symbol,
    pub version: u32,
    pub adapter: Address,
    pub wasm_hash: BytesN<32>,
    pub capabilities: u32,
    pub metadata_hash: BytesN<32>,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolSelection {
    pub id: Symbol,
    pub version: u32,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoundRecord {
    pub creator_funded: bool,
    pub id: u32,
    pub address: Address,
    pub creator: Address,
    pub metadata_hash: BytesN<32>,
    pub config_hash: BytesN<32>,
    pub protocols: Vec<ProtocolVersion>,
    pub created_at: u64,
}
