# Waypoint

**English** | [中文](README.zh-CN.md)

A goal-driven cross-chain execution agent. State a goal in plain language. Waypoint plans the multi-step execution, has an independent model verify the plan against your real on-chain balances, simulates every transaction before signing, and executes it after one confirmation.

- Demo video: https://youtu.be/bbQQfdj6URM
- Live app: https://waypoint.cjlin.com

> "Consolidate all assets from Execution Wallets 1, 2, and 3 across every supported chain into Execution Wallet 1, convert them to ETH, and deposit the result into the highest-yielding Aave market."

One sentence, one confirmation. Waypoint reads three wallets on three chains, bridges and swaps as needed, and deposits into the Aave market that currently pays the most.

## Problem

People are still the routing engine for their own on-chain activity. Assets are spread across chains, and every manual step can be irreversible: wrong network, bad slippage, unlimited approvals. Existing tools handle one step at a time or follow fixed templates. They do not reason across steps or chains.

## Capabilities

**8 action types:** `transfer`, `swap`, `bridge`, `cross_chain_swap`, `protocol_supply`, `protocol_withdraw`, `protocol_borrow` (Aave V3), `custom_call`.

- Same-chain swaps: Enso first, OKX DEX aggregator as automatic fallback.
- Cross-chain: LI.FI or Relay.
- Aave supply, withdraw, borrow: direct Aave Pool contract calls.
- `custom_call`: generic ABI encoding for any contract and function on a single chain. A `(contract, function)` pair the account has not used before needs explicit confirmation.
- Tokens: curated symbols or any raw ERC-20 address.

**Multi-wallet plans:** one plan can span several execution wallets. Each step is signed by the wallet it names, behind one confirmation.

**Natural-language automations:** "If Execution Wallet 1's Arbitrum Aave health factor drops below 1.5, repay 50% of its USDC debt." Waypoint drafts a typed rule, you confirm once, and a background monitor executes it on-chain. Supports DCA (flexible schedules, stop conditions) and health-factor repay.

**Live best-yield selection:** for "the highest-yielding Aave market", yields are queried live across candidate chains.

## Architecture

Seven single-purpose agents. Each is a separate model call with its own system prompt and a schema-validated output.

```
Triage → Readiness → Automation Intent → Intent → Planner
                                                     │
                            ┌────────────────────────┴───────┐
                            ▼                                ▼
                    Goal-Match review              Feasibility review
                    (separate model/provider)      (separate model/provider)
```

1. **Triage**: does the request need real balances?
2. **Readiness**: enough information to act? If not, ask one clarifying question.
3. **Automation Intent**: recurring or conditional request? If so, produce a typed draft that still needs your confirmation.
4. **Intent**: turn language plus real chain state into a structured goal.
5. **Planner**: build a dependency-ordered plan, then validate it in deterministic code.
6. **Goal-Match** and 7. **Feasibility**: an independent review on a separately configured model. Does the plan match the goal, and can it run against real balances?

Language judgment goes to the model with good context. Hard constraints (gas math, signer identity, step dependencies) stay in deterministic code. Real bugs hit during development are kept in an execution knowledge base (SQLite FTS5) and retrieved on demand, next to a layered memory system.

**Execution:** every step is simulated with `eth_call` before signing. Steps run in order and stop on failure. Output amounts are decoded from real transfer logs. Cross-chain arrival is confirmed through the bridge's own status API.

## Wallets and custody

| Path | Custody |
|---|---|
| Generated execution wallet | Custodial. Created through Privy; signing authority sits with Waypoint's Authorization Key. Keys are protected by Privy's Shamir sharding and AWS Nitro Enclaves. |
| Imported execution wallet | The private key is HPKE-encrypted before it leaves the process and is not stored in plaintext. After import, custodial as above. |
| Connected browser wallet (SIWE) | Non-custodial. Signatures only, never keys. |
| EIP-7702 + MetaMask delegation | Non-custodial. Narrow, expiring, scoped delegation to a relayer. |

Execution wallets can be exported back to self-custody at any time.

## Tech stack

TypeScript, Express, viem, zod, better-sqlite3, SIWE, Privy, MetaMask Smart Accounts Kit, LI.FI, Relay, Enso, OKX DEX API, Aave V3, Alchemy, OpenAI-compatible model APIs.

## Run locally

```bash
cd backend
cp .env.example .env     # fill in your own keys
npm install
npm run dev              # http://127.0.0.1:8787
```

In another terminal:

```bash
cd frontend
python3 -m http.server 3005
# open http://127.0.0.1:3005/app.html   (landing page: index.html)
```

## Layout

```
backend/    API, agents, planner, orchestrator, adapters, automations
frontend/   index.html (landing), app.html (app UI)
logo/       brand assets
```
