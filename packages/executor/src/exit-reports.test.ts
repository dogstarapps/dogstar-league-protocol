import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  BoundContract,
  type Deployment,
  type ManagedPosition,
  type RoundSnapshot,
} from "../../sdk/src/index.js";
import { exitReportProvider } from "./exit-reports.js";
const id = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const adapter = id(1),
  market = id(2),
  hash = new Uint8Array(32).fill(3),
  hashText = "03".repeat(32);
const position = { adapter } as ManagedPosition;
const snapshot = {
  record: { protocols: [{ adapter, capabilities: 24, wasm_hash: hash }] },
} as RoundSnapshot;
const deployment = {
  readSource: "GASI5ZPQHRTDBKWZRQL63NMOOVUKL7QFRVX6ZNZGOB4YAYVDK6WRWTIQ",
  rpcUrl: "https://soroban-testnet.stellar.org",
} as Deployment;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function configuration(value: unknown) {
  const path = join(
    mkdtempSync(join(tmpdir(), "dl-exit-reports-")),
    "sources.json",
  );
  writeFileSync(path, JSON.stringify(value));
  return path;
}
describe("operator-owned signed report sources", () => {
  it("accepts complete bytes only after the admitted adapter matches the configured market", async () => {
    const file = join(
      mkdtempSync(join(tmpdir(), "dl-report-file-")),
      "report.json",
    );
    writeFileSync(file, JSON.stringify({ fullReport: "0x010203" }));
    const provider = await exitReportProvider(
      configuration([{ adapter, market, marketHash: hashText, file }]),
      deployment,
    );
    vi.spyOn(BoundContract.prototype, "read").mockResolvedValue({
      market,
      market_hash: hash,
    });
    const request = await provider(position, snapshot);
    const decoded = scValToNative(xdr.ScVal.fromXDR(Buffer.from(request)));
    expect(new Uint8Array(decoded.price)).toEqual(new Uint8Array([1, 2, 3]));
    vi.mocked(BoundContract.prototype.read).mockResolvedValue({
      market: id(9),
      market_hash: hash,
    });
    await expect(provider(position, snapshot)).rejects.toThrow(
      "pinned position market",
    );
  });
  it("keeps credentials in operator headers and rejects display-only provider responses", async () => {
    const provider = await exitReportProvider(
      configuration([
        {
          adapter,
          market,
          marketHash: hashText,
          url: "https://reports.example/feed",
          authorizationEnv: "DL_TEST_REPORT_TOKEN",
        },
      ]),
      deployment,
    );
    vi.spyOn(BoundContract.prototype, "read").mockResolvedValue({
      market,
      market_hash: hash,
    });
    vi.stubEnv("DL_TEST_REPORT_TOKEN", "Bearer fixture-token");
    const fetcher = vi.fn(async (_url: string | URL, _options?: RequestInit) =>
      Response.json({ price: "0.16" }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(provider(position, snapshot)).rejects.toThrow("display price");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { authorization: "Bearer fixture-token" },
      redirect: "error",
    });
    await expect(
      exitReportProvider(
        configuration([
          {
            adapter,
            market,
            marketHash: hashText,
            url: "http://untrusted.example/report",
          },
        ]),
        deployment,
      ),
    ).rejects.toThrow("HTTPS");
    expect(await provider({ ...position, adapter: id(7) }, snapshot)).toEqual(
      new Uint8Array(),
    );
  });
});
