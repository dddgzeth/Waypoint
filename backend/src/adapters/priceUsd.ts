/**
 * Live USD price lookup, used by orchestrator.ts to enforce a hard per-step
 * dollar cap before ever signing a real transaction, and by /wallet/portfolio
 * to value a wallet's real holdings.
 *
 * Switched from CoinGecko's anonymous public API to CoinMarketCap's Pro API
 * (a real per-key metered plan: 15,000 credits/month, 50 req/min — verified
 * via a real /v1/key/info call) after CoinGecko's anonymous tier started
 * returning 429s mid-session from this project's own testing volume — a
 * real, observed failure, not a hypothetical one. CMC's classic
 * /v2/cryptocurrency/quotes/latest only takes id/symbol/slug (confirmed by a
 * live 400 when trying an `address` param); pricing by ERC20 contract
 * address needs CMC's separate DEX API, /v1/dex/token/price?address=&platform=
 * — verified for real against USDC on base/arbitrum/polygon/ethereum. The
 * batch variant (/v1/dex/token/price/batch) isn't available on this key's
 * plan (confirmed via a live 1006 error), so this still makes one request
 * per token — a short in-memory cache keeps repeat portfolio views cheap.
 */
import { getChain } from "../chains/index.js";

const CMC_BASE = "https://pro-api.coinmarketcap.com";

function apiKey(): string {
  const key = process.env.CMC_API_KEY;
  if (!key) throw new Error("CMC_API_KEY environment variable not set");
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A wallet's real discovered token list regularly runs into the dozens (see
 * stateReader.ts) — with no batch pricing endpoint on this plan, that's one
 * CMC request per token, and CMC's real limit is 50 req/min. A single
 * portfolio load firing that many requests in a burst can genuinely trip a
 * 429 — verified for real (a wallet holding a legitimate, correctly-priced
 * token like XSGD still showed $0 because a *different* token's rate-limited
 * request landed in the same burst and the resulting error got treated the
 * same as "not listed"). One retry after a short backoff absorbs a
 * same-burst 429 without silently mispricing a real token as worthless.
 */
async function cmcFetch(path: string, attempt = 0): Promise<any> {
  const res = await fetch(`${CMC_BASE}${path}`, { headers: { "X-CMC_PRO_API_KEY": apiKey() } });
  if (res.status === 429 && attempt === 0) {
    await sleep(1500);
    return cmcFetch(path, attempt + 1);
  }
  const body = await res.json();
  if (!res.ok || (body.status && body.status.error_code && body.status.error_code !== "0" && body.status.error_code !== 0)) {
    throw new Error(`CoinMarketCap error: ${body.status?.error_message ?? res.status}`);
  }
  return body;
}

// Short cache — a real user re-opening the Wallet tab shouldn't burn a fresh
// credit per token every time; prices don't need per-second freshness here.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: number; expires: number }>();
function cacheGet(key: string): number | undefined {
  const hit = cache.get(key);
  return hit && hit.expires > Date.now() ? hit.value : undefined;
}
function cacheSet(key: string, value: number): void {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// Only pure native tokens need a symbol-based lookup (no contract address to
// key off). ERC20s — including WETH — always carry a real address (see
// TokenBalance) and go through getUsdPriceByAddress instead.
const CMC_NATIVE_SYMBOL: Record<string, string> = {
  ETH: "ETH",
  POL: "POL",
};

// Dollar-pegged stablecoins — treated as exactly $1 rather than spending a
// credit on something that's ~$1 by design; still a real, defensible value.
const STABLE_SYMBOLS = new Set(["USDC", "USDG"]);

export async function getUsdPrice(symbol: string): Promise<number> {
  const upper = symbol.toUpperCase();
  if (STABLE_SYMBOLS.has(upper)) return 1;

  const cached = cacheGet(`sym:${upper}`);
  if (cached !== undefined) return cached;

  const cmcSymbol = CMC_NATIVE_SYMBOL[upper];
  if (!cmcSymbol) {
    throw new Error(`No USD price source configured for ${symbol}`);
  }
  const body = await cmcFetch(`/v2/cryptocurrency/quotes/latest?symbol=${cmcSymbol}&convert=USD`);
  const price = body.data?.[cmcSymbol]?.[0]?.quote?.USD?.price;
  if (typeof price !== "number") {
    throw new Error(`CoinMarketCap returned no USD price for ${symbol}`);
  }
  cacheSet(`sym:${upper}`, price);
  return price;
}

// A price quoted against a pool with almost no real liquidity isn't a real
// price — a classic honeypot/rug pattern is a contract with a thin,
// self-controlled pool reporting a wildly inflated price so a victim's
// wallet UI shows an eye-catching (fake) dollar value. Real, high-liquidity
// tokens verified during this session report liquidity in the tens/hundreds
// of millions; $2,000 is low enough to still trust a small-but-real token's
// price while rejecting a pool with essentially no real depth behind it.
const MIN_TRUSTED_LIQUIDITY_USD = 2_000;

/** USD price for any ERC20 by contract address, via CMC's DEX API. Returns null (not a throw) when the chain has no cmcPlatform configured, the token has no listing there, or the price isn't trustworthy (see below). */
export async function getUsdPriceByAddress(chainKey: string, tokenAddress: string): Promise<number | null> {
  const platform = getChain(chainKey)?.cmcPlatform;
  if (!platform) return null;

  const cacheKey = `addr:${chainKey}:${tokenAddress.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const body = await cmcFetch(`/v1/dex/token/price?address=${tokenAddress}&platform=${platform}`);
    const price = body.data?.p;
    const liquidity = body.data?.l;
    const volume24h = body.data?.v24h;
    if (typeof price !== "number") return null;
    if (typeof liquidity === "number" && liquidity < MIN_TRUSTED_LIQUIDITY_USD) return null;
    // A real, verified honeypot case caught during this session: a token
    // ($ETHG) with $39.8k of *reported* liquidity (clears the check above)
    // but v24h=0 and pc24h=0% — a static, self-controlled pool nobody has
    // actually traded against. That combination inflated one wallet's
    // displayed total by $444k on a token literally worth nothing to its
    // holder. Zero real trading activity in 24h means the quoted price has
    // never been realized by an actual trade — don't trust it regardless of
    // how much "liquidity" the pool claims to hold.
    if (typeof volume24h === "number" && volume24h <= 0) return null;
    cacheSet(cacheKey, price);
    return price;
  } catch {
    return null;
  }
}

/**
 * USD value for an amount of a token. Pass chainKey + tokenAddress (from a
 * TokenBalance, which always carries one for ERC20s, including WETH) to
 * price arbitrary discovered tokens by address; omit only for true native
 * tokens. Throws when no price source is available — callers that want a
 * soft "$0, unknown" for display (e.g. /wallet/portfolio) catch it
 * themselves rather than this function silently returning 0.
 */
export async function getUsdValue(
  symbol: string,
  amount: number,
  location?: { chainKey: string; tokenAddress: string | null }
): Promise<number> {
  if (location?.tokenAddress) {
    const price = await getUsdPriceByAddress(location.chainKey, location.tokenAddress);
    if (price === null) {
      throw new Error(`No USD price source configured for ${symbol} (${location.tokenAddress} on ${location.chainKey})`);
    }
    return price * amount;
  }
  const price = await getUsdPrice(symbol);
  return price * amount;
}
