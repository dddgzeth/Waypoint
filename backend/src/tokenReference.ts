/** A plan can name a curated token symbol or any ERC-20 contract address. */
import { createPublicClient, erc20Abi, getAddress, isAddress } from "viem";
import { getChain } from "./chains/index.js";
import { alchemyHttp } from "./adapters/alchemyTransport.js";
import { NATIVE_SYMBOL } from "./tokenRegistry.js";

export function isContractTokenReference(token: string): token is `0x${string}` {
  // A pasted address is frequently mixed-case without being a valid EIP-55
  // checksum string. It is still an unambiguous 20-byte address; normalize it
  // before use instead of rejecting a legitimate user input over typography.
  return isAddress(token, { strict: false });
}

export function resolveTokenReference(chainKey: string, token: string, nativePlaceholder?: `0x${string}`): `0x${string}` | undefined {
  if (isContractTokenReference(token)) return getAddress(token.toLowerCase()) as `0x${string}`;
  return token.toUpperCase() === NATIVE_SYMBOL[chainKey] ? nativePlaceholder : undefined;
}

export async function tokenReferenceDecimals(chainKey: string, token: string): Promise<number> {
  if (token.toUpperCase() === NATIVE_SYMBOL[chainKey]) return 18;
  if (!isContractTokenReference(token)) throw new Error(`No token metadata for ${token} on ${chainKey}`);
  // Quote construction needs one thing only: the contract's unit scale.
  // symbol() / name() are display metadata and some tradeable ERC-20s omit
  // or implement them unusually. Do not make an arbitrary contract-address
  // swap impossible merely because optional display fields cannot be read.
  const chain = getChain(chainKey);
  if (!chain) throw new Error(`Unknown chain ${chainKey}`);
  const client = createPublicClient({ chain: chain.viemChain, transport: alchemyHttp(chainKey) });
  const decimals = await client.readContract({
    address: getAddress(token.toLowerCase()) as `0x${string}`,
    abi: erc20Abi,
    functionName: "decimals",
  });
  return Number(decimals);
}
