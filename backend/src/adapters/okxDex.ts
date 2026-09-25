/**
 * OKX Onchain OS DEX aggregator adapter for same-chain EVM swaps.
 *
 * The adapter only asks OKX for a route. Signing, Alchemy simulation,
 * broadcasting, confirmation and receipt-based output measurement remain in
 * orchestrator.ts, so every swap provider shares one execution path.
 */
import { createHmac } from "node:crypto";
import { formatUnits, parseUnits } from "viem";
import { getChain } from "../chains/index.js";
import { NATIVE_PLACEHOLDER_EEEE } from "../tokenRegistry.js";
import { resolveTokenReference, tokenReferenceDecimals } from "../tokenReference.js";

const OKX_BASE_URL = "https://web3.okx.com";
const DEX_PATH = "/api/v6/dex/aggregator";

type OkxEnvelope<T> = {
  code: string;
  msg?: string;
  data?: T[];
};

type OkxTransaction = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
};

type OkxRoute = {
  toTokenAmount: string;
  estimateGasFee?: string;
  tradeFee?: string;
  priceImpactPercent?: string;
};

type OkxSwapPayload = {
  routerResult: OkxRoute;
  tx: OkxTransaction;
};

type OkxSupportedChain = {
  chainIndex: string;
  dexTokenApproveAddress?: `0x${string}`;
};

export interface OkxDexQuoteRequest {
  chainKey: string;
  fromAddress: `0x${string}`;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  recipientAddress?: `0x${string}`;
  slippagePercent?: string;
}

export interface OkxDexRoute {
  estimatedAmountOut: number;
  estimatedGasFee: string | null;
  tradeFeeUsd: string | null;
  priceImpactPercent: string | null;
  transactionRequest: { to: `0x${string}`; data: `0x${string}`; value: `0x${string}` };
  /** ERC-20 spender returned by OKX's supported-chain endpoint. */
  approvalSpender: `0x${string}` | null;
  raw: unknown;
}

function credentials(): { key: string; secret: string; passphrase: string } {
  const key = process.env.OKX_ONCHAIN_API_KEY;
  const secret = process.env.OKX_ONCHAIN_SECRET_KEY;
  const passphrase = process.env.OKX_ONCHAIN_PASSPHRASE;
  if (!key || !secret || !passphrase) {
    throw new Error("OKX_ONCHAIN_API_KEY, OKX_ONCHAIN_SECRET_KEY and OKX_ONCHAIN_PASSPHRASE must be set in backend/.env");
  }
  return { key, secret, passphrase };
}

/** Signs the exact path + query sent to OKX. The query cannot be reordered
 * after this point, because it is part of the signature preimage. */
async function okxGet<T>(path: string, params: URLSearchParams): Promise<T[]> {
  const { key, secret, passphrase } = credentials();
  const requestPath = `${path}?${params.toString()}`;
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", secret).update(`${timestamp}GET${requestPath}`).digest("base64");
  const response = await fetch(`${OKX_BASE_URL}${requestPath}`, {
    headers: {
      "OK-ACCESS-KEY": key,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": passphrase,
      "OK-ACCESS-SIGN": signature,
    },
  });
  const body = (await response.json().catch(() => null)) as OkxEnvelope<T> | null;
  if (!response.ok || !body || body.code !== "0") {
    throw new Error(`OKX DEX request failed (${response.status}): ${body?.msg ?? "invalid response"}`);
  }
  return body.data ?? [];
}

async function approvalSpender(chainIndex: string): Promise<`0x${string}` | null> {
  const data = await okxGet<OkxSupportedChain>(`${DEX_PATH}/supported/chain`, new URLSearchParams({ chainIndex }));
  return data[0]?.dexTokenApproveAddress ?? null;
}

function tokenAddress(chainKey: string, token: string): `0x${string}` {
  const address = resolveTokenReference(chainKey, token, NATIVE_PLACEHOLDER_EEEE);
  if (!address) throw new Error(`OKX DEX requires a contract address or the native ${getChain(chainKey)?.nativeSymbol} symbol; received ${token}`);
  return address;
}

async function requestRoute(params: OkxDexQuoteRequest, endpoint: "quote" | "swap"): Promise<{ route: OkxRoute; tx: OkxTransaction | null; outputDecimals: number; inputIsNative: boolean; chainIndex: string }> {
  const chain = getChain(params.chainKey);
  if (!chain) throw new Error(`OKX DEX does not support unknown Waypoint chain ${params.chainKey}`);
  const [inputDecimals, outputDecimals] = await Promise.all([
    tokenReferenceDecimals(params.chainKey, params.tokenIn),
    tokenReferenceDecimals(params.chainKey, params.tokenOut),
  ]);
  const amount = parseUnits(String(params.amountIn), inputDecimals).toString();
  const input = tokenAddress(params.chainKey, params.tokenIn);
  const output = tokenAddress(params.chainKey, params.tokenOut);
  const chainIndex = String(chain.chainId);
  const query = new URLSearchParams({
    chainIndex,
    amount,
    fromTokenAddress: input,
    toTokenAddress: output,
  });
  if (endpoint === "swap") {
    // OKX computes a fresh market-dependent tolerance. `slippagePercent` is
    // still required by the endpoint, but is overridden whenever
    // `autoSlippage=true` is present.
    query.set("slippagePercent", params.slippagePercent ?? "0");
    if (params.slippagePercent === undefined) query.set("autoSlippage", "true");
    query.set("userWalletAddress", params.fromAddress);
    if (params.recipientAddress && params.recipientAddress.toLowerCase() !== params.fromAddress.toLowerCase()) {
      query.set("swapReceiverAddress", params.recipientAddress);
    }
  }
  if (endpoint === "swap") {
    const data = await okxGet<OkxSwapPayload>(`${DEX_PATH}/${endpoint}`, query);
    const payload = data[0];
    if (!payload?.routerResult || !payload.tx) throw new Error("OKX DEX returned a route without transaction calldata");
    return { route: payload.routerResult, tx: payload.tx, outputDecimals, inputIsNative: input.toLowerCase() === NATIVE_PLACEHOLDER_EEEE.toLowerCase(), chainIndex };
  }
  const data = await okxGet<OkxRoute>(`${DEX_PATH}/${endpoint}`, query);
  const route = data[0];
  if (!route) throw new Error("OKX DEX returned no route");
  return { route, tx: null, outputDecimals, inputIsNative: input.toLowerCase() === NATIVE_PLACEHOLDER_EEEE.toLowerCase(), chainIndex };
}

/** Read-only best-price query, used by the provider comparison runner. */
export async function getOkxDexQuote(params: OkxDexQuoteRequest): Promise<Omit<OkxDexRoute, "transactionRequest" | "approvalSpender">> {
  const { route, outputDecimals } = await requestRoute(params, "quote");
  return {
    estimatedAmountOut: Number(formatUnits(BigInt(route.toTokenAmount), outputDecimals)),
    estimatedGasFee: route.estimateGasFee ?? null,
    tradeFeeUsd: route.tradeFee ?? null,
    priceImpactPercent: route.priceImpactPercent ?? null,
    raw: route,
  };
}

/** Gets fresh transaction calldata and the router allowance target for a real
 * same-chain swap. This never signs or broadcasts a transaction. */
export async function getOkxDexSwapRoute(params: OkxDexQuoteRequest): Promise<OkxDexRoute> {
  const { route, tx, outputDecimals, inputIsNative, chainIndex } = await requestRoute(params, "swap");
  return {
    estimatedAmountOut: Number(formatUnits(BigInt(route.toTokenAmount), outputDecimals)),
    estimatedGasFee: route.estimateGasFee ?? null,
    tradeFeeUsd: route.tradeFee ?? null,
    priceImpactPercent: route.priceImpactPercent ?? null,
    transactionRequest: {
      to: tx!.to,
      data: tx!.data,
      value: tx!.value.startsWith("0x") ? (tx!.value as `0x${string}`) : (`0x${BigInt(tx!.value || "0").toString(16)}` as `0x${string}`),
    },
    approvalSpender: inputIsNative ? null : await approvalSpender(chainIndex),
    raw: route,
  };
}
