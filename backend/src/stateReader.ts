/**
 * State aggregation layer.
 *
 * Reads native balance + every ERC20 the address has ever transacted with
 * (via Alchemy's real token-discovery API — see adapters/alchemy.ts), not
 * just a hardcoded native+one-stablecoin list. That old fixed scope made
 * real wallet assets invisible: a real test wallet held 5+ tokens on Base
 * alone that the fixed list never saw. Alchemy doesn't index every chain
 * (confirmed: not Robinhood Chain) — those chains fall back to the fixed
 * `tokens` list in chains/*.ts, which is still the only source for chains
 * without a real discovery API.
 */
import { createPublicClient, formatUnits, erc20Abi } from "viem";
import type { WalletState, TokenBalance } from "./models.js";
import { VIEM_CHAIN, NATIVE_SYMBOL } from "./tokenRegistry.js";
import { discoverTokenBalances, getTokenMetadataBatch } from "./adapters/alchemy.js";
import { alchemyHttp } from "./adapters/alchemyTransport.js";
import { getAavePositionForReceiptToken } from "./adapters/aaveYield.js";
import { resolveTokenReference, tokenReferenceDecimals } from "./tokenReference.js";

// Classic airdrop-phishing pattern: a spam contract sets its own name/symbol
// to something like "Visit https://x.io to claim reward", "PAWS | t.me/s/BD_PAWS |
// claim yours", or "ACCESS [ETHENA-ERC.COM] TO CLAIM" so it renders directly
// in any wallet UI that trusts on-chain token metadata blindly — verified
// against a real wallet's actual discovered token list, which held over a
// hundred of these across 4 chains. An explicit http(s):// or www. is an
// instant match; short of that, a domain-shaped substring (any-label.tld,
// deliberately no fixed TLD allowlist — the wild spans .com/.io/.xyz/.site/
// .lat/.ac/.vercel.app/t.me/t.ly and more) combined with bait wording or
// bracket/pipe/URL-scheme formatting catches the rest, while a bare
// project name that happens to contain a dot (e.g. a real "ether.fi") stays
// visible since it carries neither signal.
const URL_PATTERN = /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i;
const DOMAIN_PATTERN = /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:[a-z]{2,24})\b/i;
const BAIT_WORD_PATTERN = /\b(claim|visit|access|reward|airdrop|voucher|swap|bridge|bonus|gift|redeem|telegram)\b/i;
const BAIT_FORMATTING_PATTERN = /[|[\]>]/;
function isLikelySpamToken(symbol: string, name: string): boolean {
  const combined = `${symbol} ${name}`;
  if (URL_PATTERN.test(combined)) return true;
  return DOMAIN_PATTERN.test(combined) && (BAIT_WORD_PATTERN.test(combined) || BAIT_FORMATTING_PATTERN.test(combined));
}

async function readChainBalances(chainKey: string, address: `0x${string}`, includePositions: boolean): Promise<TokenBalance[]> {
  const chain = VIEM_CHAIN[chainKey];
  const nativeSymbol = NATIVE_SYMBOL[chainKey];
  const client = createPublicClient({
    chain,
    transport: alchemyHttp(chainKey),
  });

  const nativeBalance = await client.getBalance({ address });

  const balances: TokenBalance[] = [];
  const nativeAmount = Number(formatUnits(nativeBalance, 18));
  if (nativeAmount > 0) {
    balances.push({ chain: chainKey, token: nativeSymbol, amount: nativeAmount, tokenAddress: null, decimals: 18, logo: null });
  }
  // ERC-20 discovery finds every held contract; metadata/decimals are read
  // from each discovered contract through its ABI, not a token list.
  const discovered = await discoverTokenBalances(chainKey, address).catch(() => []);
  const metadatas = await getTokenMetadataBatch(chainKey, discovered.map((token) => token.contractAddress));
  discovered.forEach((t) => {
    const meta = metadatas.get(t.contractAddress.toLowerCase());
    if (!meta) return; // malformed/non-standard token contract — skip rather than show garbage
    if (isLikelySpamToken(meta.symbol, meta.name)) return;
    const amount = Number(formatUnits(t.balanceRaw, meta.decimals));
    if (amount > 0) {
      balances.push({ chain: chainKey, token: meta.symbol, amount, tokenAddress: t.contractAddress, decimals: meta.decimals, logo: meta.logo });
    }
  });

  // Determine Aave receipt positions only for contracts the wallet actually
  // holds. This is an ABI check on each candidate aToken, not a scan of every
  // market whenever any wallet balance is rendered.
  if (includePositions) {
    const positions = await Promise.all(
      balances.map(async (balance) => balance.tokenAddress ? getAavePositionForReceiptToken(chainKey, balance.tokenAddress as `0x${string}`) : null)
    );
    balances.forEach((balance, index) => {
      const reserve = positions[index];
      if (reserve) balance.position = { protocol: "aave", underlyingToken: reserve.underlyingAddress };
    });
  }

  return balances;
}

export function getMockWalletState(address = "0xDEMO...WAYPOINT"): WalletState {
  // Example from plan.md Section 4.1: Base 0.5 ETH / Polygon 200 USDC / Arbitrum 0.1 ETH.
  // Kept as a fallback for running the pipeline without RPC access or a wallet address.
  return {
    address,
    balances: [
      { chain: "base", token: "ETH", amount: 0.5, tokenAddress: null, decimals: 18, logo: null },
      { chain: "polygon", token: "USDC", amount: 200.0, tokenAddress: null, decimals: 6, logo: null },
      { chain: "arbitrum", token: "ETH", amount: 0.1, tokenAddress: null, decimals: 18, logo: null },
    ],
  };
}

/** Reads the current balance of one specific token (native or ERC20) for one address on one chain. Used by orchestrator.ts to diff balances before/after a step to find the real output amount. */
export async function getSingleTokenBalance(chainKey: string, symbol: string, address: `0x${string}`): Promise<number> {
  const chain = VIEM_CHAIN[chainKey];
  const client = createPublicClient({ chain, transport: alchemyHttp(chainKey) });
  if (symbol.toUpperCase() === NATIVE_SYMBOL[chainKey]) {
    const balance = await client.getBalance({ address });
    return Number(formatUnits(balance, 18));
  }
  const tokenAddress = resolveTokenReference(chainKey, symbol);
  if (!tokenAddress) {
    throw new Error(`No known address for ${symbol} on ${chainKey}`);
  }
  const [balance, decimals] = await Promise.all([
    client.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
    }),
    tokenReferenceDecimals(chainKey, symbol),
  ]);
  return Number(formatUnits(balance, decimals));
}

export async function getWalletState(address: string, options: { includePositions?: boolean } = {}): Promise<WalletState> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(`Not a valid EVM address: ${address}`);
  }
  const typedAddress = address as `0x${string}`;

  // Public RPC endpoints are shared resources. Reading every chain at once
  // creates a burst of native/token/discovery calls which makes an otherwise
  // healthy wallet read fail with a rate-limit response. The state is still
  // one coherent snapshot for planning; read its chains in a predictable
  // sequence so a real multi-wallet goal can be planned reliably.
  const results: TokenBalance[][] = [];
  for (const chainKey of Object.keys(VIEM_CHAIN)) {
    results.push(await readChainBalances(chainKey, typedAddress, Boolean(options.includePositions)));
  }

  return {
    address,
    balances: results.flat(),
  };
}
