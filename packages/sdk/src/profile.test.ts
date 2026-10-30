import { describe, it, expect } from "vitest";
import {
  avatarCid,
  normalizeAvatarCid,
  verifyAvatar,
  avatarInfo,
  validateNickname,
  profileContract,
  PROFILE_BUILD_ARTIFACT,
} from "./profile.js";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
    "base64",
  ),
);
describe("public player profile and content-addressed avatars", () => {
  it("verifies actual image bytes and refuses a corrupted gateway response", async () => {
    const cid = await avatarCid(png);
    expect(cid).toHaveLength(59);
    expect(normalizeAvatarCid(`ipfs://${cid}`)).toBe(cid);
    expect(await verifyAvatar(cid, png)).toEqual({
      mime: "image/png",
      width: 1,
      height: 1,
    });
    const corrupt = png.slice();
    corrupt[40] ^= 1;
    await expect(verifyAvatar(cid, corrupt)).rejects.toThrow("do not match");
  });
  it("rejects remote URLs, noncanonical identifiers, unsupported formats and oversized dimensions", async () => {
    for (const cid of [
      "https://example.com/image.png",
      "ipfs://QmInvalid",
      "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",
    ])
      expect(() => normalizeAvatarCid(cid)).toThrow();
    expect(() => avatarInfo(new TextEncoder().encode("<svg/>"))).toThrow(
      "PNG or JPEG",
    );
    const bomb = png.slice();
    new DataView(bomb.buffer).setUint32(16, 100000);
    expect(() => avatarInfo(bomb)).toThrow("2048");
    await expect(avatarCid(new Uint8Array(1024 * 1024 + 1))).rejects.toThrow(
      "1 MiB",
    );
    for (const name of [
      "",
      " Moon",
      "Moon ",
      "<script>",
      "Möon",
      "A".repeat(33),
    ])
      expect(() => validateNickname(name)).toThrow();
    expect(validateNickname("Moon Dog_7")).toBe("Moon Dog_7");
  });
  it("encodes owner-bound revisioned edits and rejects incompatible profile manifests", () => {
    const deployment = {
      version: 1 as const,
      address: StrKey.encodeContract(new Uint8Array(32).fill(1)),
      ...PROFILE_BUILD_ARTIFACT,
    };
    const owner = Keypair.random().publicKey();
    const contract = profileContract(deployment, owner);
    expect(
      contract.spec.funcArgsToScVals("set_profile", {
        owner,
        nickname: "Moon",
        avatar_cid: "",
        expected_revision: 0,
      }),
    ).toHaveLength(4);
    expect(() =>
      profileContract({ ...deployment, interfaceHash: "0".repeat(64) }, owner),
    ).toThrow("Unsupported");
    expect(() =>
      contract.spec.funcArgsToScVals("transfer", { to: owner }),
    ).toThrow();
    expect(() =>
      contract.spec.funcArgsToScVals("upgrade", { hash: new Uint8Array(32) }),
    ).toThrow();
  });
});
