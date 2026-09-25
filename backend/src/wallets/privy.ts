/**
 * Privy embedded server wallets — the hands-free/triggered execution path.
 * A dedicated Waypoint execution wallet, separate from a user's own wallet,
 * signed autonomously by our backend via an Authorization Key (a P-256
 * keypair we hold locally; the private key never touches Privy). Unlike the
 * MetaMask Delegation Framework path (src/delegation/), this does require
 * moving funds into a new address — the tradeoff for "works with any real
 * user today, no browser-wallet gap" (see plan-finals.md for the full
 * reasoning).
 *
 * `createViemAccount` returns an object shaped like viem's `Account`, so the
 * existing orchestrator (orchestrator.ts) can execute plans against a Privy
 * wallet exactly as it does against a local PrivateKeyAccount — no separate
 * execution path needed.
 */
import { PrivyClient } from "@privy-io/node";
import { createViemAccount, type PrivyViemAccount } from "@privy-io/node/viem";
import type { AuthorizationContext } from "@privy-io/node";
import { privateKeyToAccount } from "viem/accounts";

let _client: PrivyClient | null = null;

export function getPrivyClient(): PrivyClient {
  if (_client) return _client;
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new Error("PRIVY_APP_ID / PRIVY_APP_SECRET not set");
  _client = new PrivyClient({ appId, appSecret });
  return _client;
}

function getAuthorizationContext(): AuthorizationContext {
  const key = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY_B64;
  if (!key) throw new Error("PRIVY_AUTHORIZATION_PRIVATE_KEY_B64 not set");
  return { authorization_private_keys: [key] };
}

/** Creates a new Privy Ethereum wallet owned by our Authorization Key quorum — no user JWT involved, ever. */
export async function createExecutionWallet(): Promise<{ walletId: string; address: `0x${string}` }> {
  const quorumId = process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID;
  if (!quorumId) throw new Error("PRIVY_AUTHORIZATION_KEY_QUORUM_ID not set");
  const client = getPrivyClient();
  const wallet = await client.wallets().create({ chain_type: "ethereum", owner_id: quorumId });
  return { walletId: wallet.id, address: wallet.address as `0x${string}` };
}

/**
 * Resolves an Ethereum private key to its address before any import request is
 * sent. Accepting the common no-0x form here keeps that input detail out of the
 * rest of the wallet flow.
 */
export function executionWalletAddressFromPrivateKey(privateKey: string): `0x${string}` {
  const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Enter a valid 32-byte Ethereum private key");
  }
  try {
    return privateKeyToAccount(normalized as `0x${string}`).address;
  } catch {
    throw new Error("Enter a valid 32-byte Ethereum private key");
  }
}

/**
 * Imports an existing Ethereum key into the same Privy Authorization-Key
 * quorum used by wallets created in Waypoint. The SDK HPKE-encrypts the key
 * before sending it to Privy; Waypoint never persists the plaintext key.
 */
export async function importExecutionWallet(privateKey: string): Promise<{ walletId: string; address: `0x${string}` }> {
  const quorumId = process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID;
  if (!quorumId) throw new Error("PRIVY_AUTHORIZATION_KEY_QUORUM_ID not set");

  const address = executionWalletAddressFromPrivateKey(privateKey);
  const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const wallet = await getPrivyClient().wallets().import({
    wallet: {
      address,
      chain_type: "ethereum",
      entropy_type: "private-key",
      private_key: normalized,
    },
    owner_id: quorumId,
  });
  return { walletId: wallet.id, address: wallet.address as `0x${string}` };
}

/** Returns a viem-compatible Account for a Privy wallet — drop-in for orchestrator.runPlan(). */
export function getExecutionAccount(walletId: string, address: `0x${string}`): PrivyViemAccount {
  return createViemAccount(getPrivyClient(), {
    walletId,
    address,
    authorizationContext: getAuthorizationContext(),
  });
}

/**
 * Exports the wallet's raw private key — a self-custody escape hatch (same
 * idea as MetaMask/Coinbase Wallet letting you export an embedded wallet).
 * Encryption in transit is HPKE, handled entirely inside the SDK: it
 * generates a fresh ephemeral keypair, sends only the public half to Privy,
 * and decrypts the returned ciphertext locally — the private key is never
 * sent in plaintext over the wire, verified against the SDK's own shipped
 * source (setupHPKERecipient in @privy-io/node/lib/cryptography), not
 * assumed. Whoever calls this function sees the plaintext key in memory —
 * callers must never log it.
 */
export async function exportExecutionWalletPrivateKey(walletId: string): Promise<`0x${string}`> {
  const client = getPrivyClient();
  const result = await client.wallets().exportPrivateKey(walletId, {
    authorization_context: getAuthorizationContext(),
  });
  // Privy returns the raw 64-hex-char key with no 0x prefix — confirmed by
  // testing (viem's privateKeyToAccount otherwise rejects it outright).
  const raw = result.private_key.startsWith("0x") ? result.private_key : `0x${result.private_key}`;
  return raw as `0x${string}`;
}
