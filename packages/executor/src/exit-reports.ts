import { readFile, stat } from "node:fs/promises";
import { StrKey } from "@stellar/stellar-sdk";
import {
  BoundContract,
  decodeFullReport,
  encodeZenexCloseRequest,
  hex,
  type Deployment,
  type ManagedPosition,
  type RoundSnapshot,
  type ZenexSettings,
} from "../../sdk/src/index.js";
export type ExitRequestProvider = (
  position: ManagedPosition,
  snapshot: RoundSnapshot,
) => Promise<Uint8Array>;
interface Source {
  adapter: string;
  market: string;
  marketHash: string;
  file?: string;
  url?: string;
  authorizationEnv?: string;
}
export async function exitReportProvider(
  path: string,
  deployment: Deployment,
): Promise<ExitRequestProvider> {
  if ((await stat(path)).size > 64000)
    throw new Error("Report source configuration is too large.");
  const sources = JSON.parse(await readFile(path, "utf8")) as Source[];
  if (!Array.isArray(sources) || sources.length > 20)
    throw new Error("Configure at most twenty explicit report sources.");
  const configured = new Map<string, Source>();
  for (const source of sources) {
    if (
      !StrKey.isValidContract(source.adapter) ||
      !StrKey.isValidContract(source.market) ||
      !/^[a-f0-9]{64}$/.test(source.marketHash) ||
      configured.has(source.adapter) ||
      !!source.file === !!source.url
    )
      throw new Error("Invalid or duplicate report source.");
    if (
      source.authorizationEnv &&
      !/^[A-Z_][A-Z0-9_]*$/.test(source.authorizationEnv)
    )
      throw new Error("Use an environment variable for report credentials.");
    if (source.url) {
      const url = new URL(source.url);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        )
      )
        throw new Error(
          "Use an HTTPS report endpoint or explicit loopback broker; put credentials in headers.",
        );
    }
    configured.set(source.adapter, source);
  }
  return async (position, snapshot) => {
    const source = configured.get(position.adapter),
      record = snapshot.record.protocols.find(
        (p) => p.adapter === position.adapter,
      );
    if (!source || record?.capabilities !== 24) return new Uint8Array();
    const settings = await new BoundContract(
      "zenex_adapter",
      position.adapter,
      deployment.readSource,
      deployment.rpcUrl,
      hex(record.wasm_hash),
    ).read<ZenexSettings>("config");
    if (
      settings.market !== source.market ||
      hex(settings.market_hash) !== source.marketHash
    )
      throw new Error(
        "The report source does not match the pinned position market.",
      );
    let text: string;
    if (source.file) {
      if ((await stat(source.file)).size > 64000)
        throw new Error("Report file is too large.");
      text = await readFile(source.file, "utf8");
    } else {
      const headers: Record<string, string> = {};
      if (source.authorizationEnv) {
        const credential = process.env[source.authorizationEnv];
        if (!credential)
          throw new Error("Configured report credentials are unavailable.");
        headers.authorization = credential;
      }
      let response: Response;
      try {
        response = await fetch(source.url!, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Fetch/header diagnostics must never copy credentials into journals.
        throw new Error("The signed-report provider is unavailable.");
      }
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get("content-length") ?? 0) > 64000
      )
        throw new Error("The signed-report provider is unavailable.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 64000) throw new Error("Report response is too large.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      text = Buffer.concat(chunks).toString("utf8");
    }
    const payload = JSON.parse(text) as { fullReport?: string };
    if (typeof payload.fullReport !== "string")
      throw new Error(
        "A display price cannot replace the complete signed report.",
      );
    // The venue's pinned oracle verifies signatures, feed and freshness on chain.
    return encodeZenexCloseRequest(decodeFullReport(payload.fullReport));
  };
}
