import {
  PROFILE_SPEC_ENTRIES,
  PROFILE_BUILD_ARTIFACT,
} from "./generated/profile-v1.js";
import { BoundContract } from "./client.js";
import { StrKey } from "@stellar/stellar-sdk";
export { PROFILE_BUILD_ARTIFACT };
export interface PlayerProfile {
  owner: string;
  nickname: string;
  avatar_cid: string;
  revision: number;
  updated_at: bigint;
}
export interface ProfileDeployment {
  address: string;
  wasmHash: string;
  interfaceHash: string;
  version: 1;
}
export function profileContract(
  deployment: ProfileDeployment,
  source: string,
  rpcUrl?: string,
) {
  if (
    deployment.version !== 1 ||
    deployment.interfaceHash !== PROFILE_BUILD_ARTIFACT.interfaceHash ||
    !/^[a-f0-9]{64}$/.test(deployment.wasmHash)
  )
    throw new Error("Unsupported player profile deployment.");
  if (!StrKey.isValidContract(deployment.address))
    throw new Error("Invalid profile contract.");
  return new BoundContract(
    "player_profile",
    deployment.address,
    source,
    rpcUrl,
    deployment.wasmHash,
  );
}
export const AVATAR_MAX_BYTES = 1024 * 1024;
const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
function encode32(bytes: Uint8Array) {
  let bits = 0,
    acc = 0,
    out = "b";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}
export function normalizeAvatarCid(input: string) {
  const cid = input.trim().replace(/^ipfs:\/\//, "");
  if (cid === "") return "";
  if (!/^b[a-z2-7]{58}$/.test(cid))
    throw new Error(
      "Use a direct IPFS image CID created from a raw SHA-256 block.",
    );
  let bits = 0,
    acc = 0;
  const decoded: number[] = [];
  for (const c of cid.slice(1)) {
    acc = (acc << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((acc >>> bits) & 255);
      acc &= (1 << bits) - 1;
    }
  }
  if (
    decoded.length !== 36 ||
    acc !== 0 ||
    decoded.slice(0, 4).some((n, i) => n !== [1, 0x55, 0x12, 32][i])
  )
    throw new Error(
      "Unsupported IPFS image CID. Upload an image to create a supported CID.",
    );
  return cid;
}
export async function avatarCid(bytes: Uint8Array) {
  if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES)
    throw new Error("Avatar images must be between 1 byte and 1 MiB.");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
  );
  return encode32(new Uint8Array([1, 0x55, 0x12, 32, ...digest]));
}
export async function verifyAvatar(cid: string, bytes: Uint8Array) {
  if (normalizeAvatarCid(cid) !== (await avatarCid(bytes)))
    throw new Error("The image bytes do not match the on-chain avatar CID.");
  return avatarInfo(bytes);
}
export function avatarInfo(bytes: Uint8Array): {
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
} {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0,
    mime: "image/png" | "image/jpeg";
  if (
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n) &&
    [73, 72, 68, 82].every((n, i) => bytes[i + 12] === n)
  ) {
    mime = "image/png";
    width = data.getUint32(16);
    height = data.getUint32(20);
  } else if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    mime = "image/jpeg";
    let i = 2;
    while (i + 3 < bytes.length) {
      if (bytes[i++] !== 255) throw new Error("Invalid JPEG avatar.");
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (i + 2 > bytes.length) break;
      const size = data.getUint16(i);
      if (size < 2 || i + size > bytes.length)
        throw new Error("Invalid JPEG avatar.");
      if ([192, 193, 194].includes(marker)) {
        if (size < 8) throw new Error("Invalid JPEG avatar.");
        height = data.getUint16(i + 3);
        width = data.getUint16(i + 5);
        break;
      }
      i += size;
    }
  } else throw new Error("Use a PNG or JPEG avatar.");
  if (
    bytes.length > AVATAR_MAX_BYTES ||
    !width ||
    !height ||
    width > 2048 ||
    height > 2048
  )
    throw new Error("Use an avatar up to 1 MiB and 2048 × 2048 pixels.");
  return { mime, width, height };
}
export function validateNickname(nickname: string) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9 _.-]{0,30}[A-Za-z0-9])?$/.test(nickname))
    throw new Error(
      "Use 1–32 letters, numbers, spaces, dots, underscores or hyphens; start and end with a letter or number.",
    );
  return nickname;
}
// Exported independently so consumers can inspect the exact profile ABI.
export { PROFILE_SPEC_ENTRIES };
