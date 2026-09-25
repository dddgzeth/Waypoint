/** Live Aave V3 reserve discovery. Token addresses come from Pool.getReservesList(),
 * and each ERC-20's name/symbol/decimals comes from that contract's ABI. */
import { createPublicClient, erc20Abi } from "viem";
import { getChain } from "../chains/index.js";
import { isContractTokenReference } from "../tokenReference.js";
import { alchemyHttp } from "./alchemyTransport.js";

const POOL_ABI = [
  { type: "function", name: "getReservesList", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  {
    type: "function", name: "getReserveData", stateMutability: "view", inputs: [{ name: "asset", type: "address" }], outputs: [{
      name: "res", type: "tuple", components: [
        { name: "configuration", type: "tuple", components: [{ name: "data", type: "uint256" }] },
        { name: "liquidityIndex", type: "uint128" }, { name: "currentLiquidityRate", type: "uint128" },
        { name: "variableBorrowIndex", type: "uint128" }, { name: "currentVariableBorrowRate", type: "uint128" },
        { name: "currentStableBorrowRate", type: "uint128" }, { name: "lastUpdateTimestamp", type: "uint40" },
        { name: "id", type: "uint16" }, { name: "aTokenAddress", type: "address" },
        { name: "stableDebtTokenAddress", type: "address" }, { name: "variableDebtTokenAddress", type: "address" },
        { name: "interestRateStrategyAddress", type: "address" }, { name: "accruedToTreasury", type: "uint128" },
        { name: "unbacked", type: "uint128" }, { name: "isolationModeTotalDebt", type: "uint128" },
      ],
    }],
  },
  {
    type: "function", name: "getUserConfiguration", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{
      name: "configuration", type: "tuple", components: [{ name: "data", type: "uint256" }],
    }],
  },
] as const;

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ATOKEN_ABI = [{ type: "function", name: "UNDERLYING_ASSET_ADDRESS", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

function liquidityRateToApy(rate: bigint): number {
  const apr = Number(rate) / Number(RAY);
  return ((1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1) * 100;
}

export interface YieldQuote {
  protocol: "aave";
  chain: string;
  /** Canonical executable identifier: ERC-20 contract address. */
  asset: `0x${string}`;
  symbol: string;
  decimals: number;
  apy: number;
  reserveId: number;
  aTokenAddress: `0x${string}`;
  stableDebtTokenAddress: `0x${string}`;
  variableDebtTokenAddress: `0x${string}`;
  underlyingAddress: `0x${string}`;
  active: boolean;
  frozen: boolean;
  paused: boolean;
  borrowingEnabled: boolean;
  variableBorrowApr: number;
}

function reserveCapabilities(configuration: bigint, variableBorrowRate: bigint) {
  const enabled = (bit: number) => ((configuration >> BigInt(bit)) & 1n) === 1n;
  return {
    active: enabled(56),
    frozen: enabled(57),
    borrowingEnabled: enabled(58),
    paused: enabled(60),
    variableBorrowApr: (Number(variableBorrowRate) / Number(RAY)) * 100,
  };
}

async function poolClient(chainKey: string) {
  const chain = getChain(chainKey);
  if (!chain?.aavePool) throw new Error(`No Aave V3 deployment known for ${chainKey}`);
  return { chain, client: createPublicClient({ chain: chain.viemChain, transport: alchemyHttp(chainKey) }) };
}

/** All live Aave reserves on a chain, with ERC-20 metadata read through ABI. */
export async function getAaveReserves(chainKey: string): Promise<YieldQuote[]> {
  const { chain, client } = await poolClient(chainKey);
  const addresses = await client.readContract({ address: chain.aavePool!, abi: POOL_ABI, functionName: "getReservesList" });
  const [reserveResults, symbolResults, decimalsResults] = await Promise.all([
    client.multicall({ allowFailure: true, contracts: addresses.map((underlyingAddress) => ({
      address: chain.aavePool!, abi: POOL_ABI, functionName: "getReserveData" as const, args: [underlyingAddress],
    })) }),
    client.multicall({ allowFailure: true, contracts: addresses.map((underlyingAddress) => ({
      address: underlyingAddress, abi: erc20Abi, functionName: "symbol" as const,
    })) }),
    client.multicall({ allowFailure: true, contracts: addresses.map((underlyingAddress) => ({
      address: underlyingAddress, abi: erc20Abi, functionName: "decimals" as const,
    })) }),
  ]);
  const rows = addresses.map((underlyingAddress, index) => {
    const reserveResult = reserveResults[index];
    const symbolResult = symbolResults[index];
    const decimalsResult = decimalsResults[index];
    if (reserveResult?.status !== "success" || symbolResult?.status !== "success" || decimalsResult?.status !== "success") return null;
    const data = reserveResult.result;
    const symbol = symbolResult.result;
    const decimals = decimalsResult.result;
    if (typeof symbol !== "string" || typeof decimals !== "number" || data.aTokenAddress.toLowerCase() === ZERO_ADDRESS) return null;
    return {
      protocol: "aave" as const,
      chain: chainKey,
      asset: underlyingAddress,
      symbol,
      decimals,
      apy: liquidityRateToApy(data.currentLiquidityRate),
      reserveId: data.id,
      aTokenAddress: data.aTokenAddress,
      stableDebtTokenAddress: data.stableDebtTokenAddress,
      variableDebtTokenAddress: data.variableDebtTokenAddress,
      underlyingAddress,
      ...reserveCapabilities(data.configuration.data, data.currentVariableBorrowRate),
    };
  });
  return rows.filter((row): row is YieldQuote => row !== null);
}

async function quoteForUnderlying(chainKey: string, underlyingAddress: `0x${string}`): Promise<YieldQuote> {
  const { chain, client } = await poolClient(chainKey);
  const [data, symbol, decimals] = await Promise.all([
    client.readContract({ address: chain.aavePool!, abi: POOL_ABI, functionName: "getReserveData", args: [underlyingAddress] }),
    client.readContract({ address: underlyingAddress, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: underlyingAddress, abi: erc20Abi, functionName: "decimals" }),
  ]);
  if (data.aTokenAddress.toLowerCase() === ZERO_ADDRESS) throw new Error(`No Aave reserve for ${underlyingAddress} on ${chainKey}`);
  return {
    protocol: "aave", chain: chainKey, asset: underlyingAddress, symbol, decimals,
    apy: liquidityRateToApy(data.currentLiquidityRate), reserveId: data.id, aTokenAddress: data.aTokenAddress,
    stableDebtTokenAddress: data.stableDebtTokenAddress, variableDebtTokenAddress: data.variableDebtTokenAddress, underlyingAddress,
    ...reserveCapabilities(data.configuration.data, data.currentVariableBorrowRate),
  };
}

export interface AaveUserAssetPosition {
  protocol: "aave";
  chain: string;
  assetAddress: `0x${string}`;
  symbol: string;
  decimals: number;
  supplied: number;
  borrowed: number;
  supplyApy: number;
  variableBorrowApr: number;
  usedAsCollateral: boolean;
  aTokenAddress: `0x${string}`;
  variableDebtTokenAddress: `0x${string}`;
}

/** Reads a user's Aave positions directly from the live Pool reserve list.
 * This deliberately does not depend on Alchemy token discovery: a wallet UI
 * must still show a protocol position when an indexer omits its aToken or debt
 * token. Reserve addresses, metadata and balances all come from contracts. */
export async function getAaveUserAssetPositions(
  chainKey: string,
  userAddress: `0x${string}`
): Promise<AaveUserAssetPosition[]> {
  const [reserves, { chain, client }] = await Promise.all([getAaveReserves(chainKey), poolClient(chainKey)]);
  if (!reserves.length) return [];

  const [configuration, balances] = await Promise.all([
    client.readContract({ address: chain.aavePool!, abi: POOL_ABI, functionName: "getUserConfiguration", args: [userAddress] }),
    client.multicall({
      allowFailure: true,
      contracts: reserves.flatMap((reserve) => [
        { address: reserve.aTokenAddress, abi: erc20Abi, functionName: "balanceOf" as const, args: [userAddress] },
        { address: reserve.variableDebtTokenAddress, abi: erc20Abi, functionName: "balanceOf" as const, args: [userAddress] },
        { address: reserve.stableDebtTokenAddress, abi: erc20Abi, functionName: "balanceOf" as const, args: [userAddress] },
      ]),
    }),
  ]);

  const rawBalance = (index: number): bigint => {
    const result = balances[index];
    return result?.status === "success" && typeof result.result === "bigint" ? result.result : 0n;
  };
  const configurationData = configuration.data;
  return reserves.flatMap((reserve, index) => {
    const suppliedRaw = rawBalance(index * 3);
    const borrowedRaw = rawBalance(index * 3 + 1) + rawBalance(index * 3 + 2);
    if (suppliedRaw === 0n && borrowedRaw === 0n) return [];
    const scale = 10 ** reserve.decimals;
    return [{
      protocol: "aave" as const,
      chain: chainKey,
      assetAddress: reserve.underlyingAddress,
      symbol: reserve.symbol,
      decimals: reserve.decimals,
      supplied: Number(suppliedRaw) / scale,
      borrowed: Number(borrowedRaw) / scale,
      supplyApy: reserve.apy,
      variableBorrowApr: reserve.variableBorrowApr,
      usedAsCollateral: ((configurationData >> BigInt(reserve.reserveId * 2 + 1)) & 1n) === 1n,
      aTokenAddress: reserve.aTokenAddress,
      variableDebtTokenAddress: reserve.variableDebtTokenAddress,
    }];
  });
}

/** Finds a reserve by canonical address or (for natural language only) its live ABI symbol. */
export async function getAaveSupplyApy(chainKey: string, asset: string): Promise<YieldQuote> {
  if (isContractTokenReference(asset)) return quoteForUnderlying(chainKey, asset);
  const reserves = await getAaveReserves(chainKey);
  const normalized = asset.toLowerCase();
  const quote = reserves
    .filter((reserve) => reserve.symbol.toLowerCase() === normalized || (asset.toUpperCase() === "ETH" && reserve.symbol.toUpperCase() === "WETH"))
    .filter((reserve) => reserve.active && !reserve.frozen && !reserve.paused)
    .sort((a, b) => b.apy - a.apy)[0];
  if (!quote) throw new Error(`No Aave reserve for ${asset} on ${chainKey}`);
  return quote;
}

/** Resolves a debt asset from live Aave reserve configuration. Several
 * reserves can expose the same ERC-20 symbol (Arbitrum has two "USDC"
 * contracts); only markets currently permitting new variable debt are
 * candidates, with the lowest live variable borrow APR preferred. */
export async function getAaveBorrowMarket(chainKey: string, asset: string): Promise<YieldQuote> {
  const candidates = isContractTokenReference(asset)
    ? [await quoteForUnderlying(chainKey, asset)]
    : (await getAaveReserves(chainKey)).filter((reserve) =>
        reserve.symbol.toLowerCase() === asset.toLowerCase() ||
        (asset.toUpperCase() === "ETH" && reserve.symbol.toUpperCase() === "WETH")
      );
  const market = candidates
    .filter((reserve) => reserve.active && !reserve.frozen && !reserve.paused && reserve.borrowingEnabled)
    .sort((a, b) => a.variableBorrowApr - b.variableBorrowApr)[0];
  if (!market) throw new Error(`No active Aave variable-borrow market for ${asset} on ${chainKey}`);
  return market;
}

/** Identifies an already-held ERC-20 as an Aave receipt token without scanning
 * every reserve: aTokens expose UNDERLYING_ASSET_ADDRESS() by ABI. */
export async function getAavePositionForReceiptToken(chainKey: string, receiptToken: `0x${string}`): Promise<YieldQuote | null> {
  try {
    const { client } = await poolClient(chainKey);
    const underlying = await client.readContract({ address: receiptToken, abi: ATOKEN_ABI, functionName: "UNDERLYING_ASSET_ADDRESS" });
    const quote = await quoteForUnderlying(chainKey, underlying);
    return quote.aTokenAddress.toLowerCase() === receiptToken.toLowerCase() ? quote : null;
  } catch {
    return null;
  }
}

export async function getAssetDebt(chainKey: string, asset: string, userAddress: `0x${string}`): Promise<{ amount: number; decimals: number }> {
  const [quote, { client }] = await Promise.all([getAaveSupplyApy(chainKey, asset), poolClient(chainKey)]);
  const reserveData = await client.readContract({
    address: getChain(chainKey)!.aavePool!, abi: POOL_ABI, functionName: "getReserveData", args: [quote.underlyingAddress],
  });
  if (reserveData.variableDebtTokenAddress.toLowerCase() === ZERO_ADDRESS) throw new Error(`No variable debt token for ${asset} on ${chainKey}`);
  const raw = await client.readContract({ address: reserveData.variableDebtTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [userAddress] });
  return { amount: Number(raw) / 10 ** quote.decimals, decimals: quote.decimals };
}

/** Highest APY for one asset, comparing live reserves on the requested chains. */
export async function findBestAaveYield(chains: string[], asset: string): Promise<YieldQuote> {
  const quotes = (await Promise.all(chains.map((chain) => getAaveSupplyApy(chain, asset).catch(() => null)))).filter(
    (quote): quote is YieldQuote => quote !== null
  );
  if (!quotes.length) throw new Error(`No Aave reserve for ${asset} on: ${chains.join(", ")}`);
  return quotes.sort((a, b) => b.apy - a.apy)[0];
}
