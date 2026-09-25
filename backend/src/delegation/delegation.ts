/**
 * EIP-7702 + MetaMask Delegation Framework — the free alternative to a paid
 * ERC-4337 bundler (ZeroDev). Verified for real on Base mainnet
 * (test-delegation-e2e-tmp.mjs): a throwaway EOA delegated via EIP-7702 to
 * MetaMask's EIP7702StatelessDeleGatorImpl, signed a caveat-scoped delegation,
 * and Waypoint's own executor wallet redeemed it directly against
 * DelegationManager — no bundler, no paymaster, one relayer-paid transaction.
 *
 * DelegationManager.redeemDelegations is a plain external function (ERC-7710) —
 * any relayer can call it directly with a normal transaction, which is why no
 * bundler is required here (see docs.metamask.io/smart-accounts-kit, "Redeeming
 * as EOA Delegate").
 */
import { createPublicClient, createWalletClient, http } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  Implementation,
  toMetaMaskSmartAccount,
  getSmartAccountsEnvironment,
  createDelegation,
  createExecution,
  ExecutionMode,
  ScopeType,
  type Delegation,
} from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import { VIEM_CHAIN, CHAIN_ID } from "../tokenRegistry.js";

export function getDelegationEnvironment(chainKey: string) {
  const chainId = CHAIN_ID[chainKey];
  if (!chainId) throw new Error(`No chain id known for ${chainKey}`);
  return getSmartAccountsEnvironment(chainId);
}

export interface SignedDelegationRecord {
  delegation: Delegation;
  authorization: unknown;
}

/**
 * Builds and signs (delegator's own key + relayer's own key both held locally)
 * an EIP-7702 authorization plus a caveat-scoped delegation granting
 * `relayerAddress` the right to call `allowedTargets` with one of
 * `allowedSelectors`, spending up to `maxValueWei` of native token per
 * redemption, until `expiresAt` (unix seconds).
 *
 * Uses the FunctionCall scope, not NativeTokenTransferAmount — that scope
 * looked like the natural fit for "cap how much value moves" but it silently
 * injects an ExactCalldataEnforcer requiring empty calldata (it's meant for
 * plain transfers only), which reverted every real swap call in testing
 * (`ExactCalldataEnforcer:invalid-calldata`). FunctionCall is the scope for
 * "call this target, with one of these function selectors, up to this value".
 *
 * Only usable when we hold the delegator's private key (e.g. a
 * server-controlled wallet) — a browser wallet cannot currently produce the
 * EIP-7702 authorization signature itself (no wallet exposes
 * eth_signAuthorization / an equivalent RPC method yet).
 */
export async function createAndSignDelegation(params: {
  chainKey: string;
  delegatorAccount: PrivateKeyAccount;
  relayerAddress: `0x${string}`;
  allowedTargets: `0x${string}`[];
  allowedSelectors: string[];
  maxValueWei: bigint;
  expiresAt: number;
}): Promise<SignedDelegationRecord> {
  const chain = VIEM_CHAIN[params.chainKey];
  const publicClient = createPublicClient({ chain, transport: http() });
  const delegatorWallet = createWalletClient({ account: params.delegatorAccount, chain, transport: http() });
  const environment = getDelegationEnvironment(params.chainKey);

  const authorization = await delegatorWallet.signAuthorization({
    account: params.delegatorAccount,
    contractAddress: environment.implementations.EIP7702StatelessDeleGatorImpl,
  });

  const delegatorSmartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Stateless7702,
    address: params.delegatorAccount.address,
    signer: { walletClient: delegatorWallet },
  });

  const delegation = createDelegation({
    to: params.relayerAddress,
    from: delegatorSmartAccount.address,
    environment: delegatorSmartAccount.environment,
    scope: {
      type: ScopeType.FunctionCall,
      targets: params.allowedTargets,
      selectors: params.allowedSelectors,
      valueLte: { maxValue: params.maxValueWei },
    },
    caveats: [{ type: "timestamp", afterThreshold: 0, beforeThreshold: params.expiresAt }],
  });
  const signature = await delegatorSmartAccount.signDelegation({ delegation });

  return { delegation: { ...delegation, signature }, authorization };
}

/**
 * Redeems a stored delegation: the relayer calls the target contract with
 * `data`/`value`, spending from the delegator's (now 7702-delegated) EOA
 * instead of its own. If the delegation hasn't been activated on-chain yet,
 * `authorization` is attached to this same transaction so activation and
 * execution happen atomically in one relayer-paid transaction.
 */
export async function redeemDelegation(params: {
  chainKey: string;
  relayerAccount: PrivateKeyAccount;
  record: SignedDelegationRecord;
  target: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  needsActivation: boolean;
}): Promise<`0x${string}`> {
  const chain = VIEM_CHAIN[params.chainKey];
  const environment = getDelegationEnvironment(params.chainKey);
  const relayerWallet = createWalletClient({ account: params.relayerAccount, chain, transport: http() });

  const execution = createExecution({ target: params.target, value: params.value, callData: params.data });
  const redeemCalldata = DelegationManager.encode.redeemDelegations({
    delegations: [[params.record.delegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[execution]],
  });

  return relayerWallet.sendTransaction({
    to: environment.DelegationManager,
    data: redeemCalldata,
    ...(params.needsActivation ? { authorizationList: [params.record.authorization as never] } : {}),
  });
}
