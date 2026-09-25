# Waypoint

**English** | [中文](README.zh-CN.md)

### Your personal onchain agent.

Say what you want done onchain. Waypoint plans the multi-step, cross-chain execution, simulates every transaction before signing, and executes it after one confirmation. It remembers you, sees everything you hold, and keeps watching when you are away.

- Demo video: https://youtu.be/bbQQfdj6URM
- Live app: https://waypoint.cjlin.com

## Vision

The ultimate goal is a personal onchain agent: one agent that works for you across every chain and wallet you use, the way a good assistant works for you across your accounts.

| It... | How |
|---|---|
| **Knows you** | Layered memory of your preferences, constraints and history. You do not restate them every time. |
| **Sees everything** | Reads all your execution and linked wallets on Ethereum, Base, Arbitrum and Polygon, with real token discovery and live DeFi positions. |
| **Acts for you** | Turns a goal into a dependency-ordered, multi-step, cross-chain plan and executes it after one confirmation. |
| **Keeps watching** | Automations run in the background, act onchain when a condition is met, and report back in your chat. |

This repository is the working foundation: the agent pipeline, the execution engine, wallets, memory, automations, and the app.

## What you can say

```
Consolidate all assets from Execution Wallets 1, 2, and 3 across every supported chain
into Execution Wallet 1, convert them to ETH, and deposit the result into the
highest-yielding Aave market.

Withdraw my USDC from Aave on Base and send 100 of it to 0x...

Borrow 1,000 USDC against my Aave position on Arbitrum and swap it to ETH.

Buy $5 of ETH with Execution Wallet 1 every day at 09:00 UTC, ten times.

If Execution Wallet 1's Arbitrum Aave health factor drops below 1.5,
automatically repay 50% of its USDC debt.
```

Waypoint asks one clarifying question when something is ambiguous, shows the full plan, and executes only after you confirm.

## How it works

```
message
  │
  ▼
Triage ─► Readiness ─► Automation Intent ─► Intent ─► Planner ─► plan shown to you
                                                         │              │
                                                         ▼              ▼
                                            Goal-Match + Feasibility    confirm
                                            (separate model)              │
                                                                          ▼
                                                     simulate ─► sign ─► execute ─► verify
```

Seven single-purpose agents. Each is its own model call with its own system prompt and a schema-validated (zod) output.

| # | Agent | Job |
|---|---|---|
| 1 | **Triage** | Does this request need real balances? Skips the multi-chain read when it does not. |
| 2 | **Readiness** | Is there enough information to act? If not, asks one specific question. |
| 3 | **Automation Intent** | Is this a recurring or conditional request? If so, builds a typed automation draft (DCA or health-factor rule) that still needs your confirmation. |
| 4 | **Intent** | Turns language plus real chain state into a structured goal. Describes what you want, never the transactions. |
| 5 | **Planner** | Builds a dependency-ordered plan: chain, asset, amount, source and destination wallet, and provider for every step. Output is validated in deterministic code. |
| 6 | **Goal-Match** | Independent review: does the plan match the parsed goal? |
| 7 | **Feasibility** | Independent review: can the plan run against your real balances, including gas for every later step? |

Agents 6 and 7 run on a separately configured model and gateway, so they do not share the planner's blind spots. They run alongside the user-facing flow and add no latency.

Design rule: language judgment goes to the model, given good context. Hard constraints (gas math, signer identity, step dependencies) stay in deterministic code.

### Deterministic guards on every plan

- Only supported chains and protocols.
- A step's declared source wallet must be a real resolved address and one of the wallets you named, never a label or placeholder.
- A transfer stays on one chain and keeps the same asset. Cross-chain sends are bridge, then transfer.
- Step outputs can only reference steps that exist.
- Aave withdraw stays on one chain and uses the underlying asset.
- If you asked for the best yield, the plan must deposit into the live best-yield market, not a convenient one.
- The plan must actually spend from the wallets you asked it to spend from.
- Native-token transfers reserve gas using the current EIP-1559 fees.

## Capabilities

**Chains:** Ethereum, Base, Arbitrum, Polygon. A chain is one file in `backend/src/chains/`; everything else reads the registry.

**8 action types**

| Action | What it does | Implementation |
|---|---|---|
| `transfer` | Send native token or ERC-20 to any address | viem |
| `swap` | Same-chain swap | Enso and OKX DEX aggregator. `SAME_CHAIN_SWAP_PRIMARY` (`enso` or `okx`) picks which is tried first; the other is the automatic fallback |
| `bridge` | Move an asset across chains | LI.FI or Relay |
| `cross_chain_swap` | Swap and bridge in one step | LI.FI or Relay |
| `protocol_supply` | Deposit into Aave V3 | Direct Aave Pool `supply()` |
| `protocol_withdraw` | Withdraw from Aave V3 | Direct Aave Pool `withdraw()` |
| `protocol_borrow` | Borrow from Aave V3 | Direct Aave Pool `borrow()` |
| `custom_call` | Any contract function on one chain | Generic ABI encoding from a function signature. A `(contract, function)` pair your account has not used before requires explicit confirmation, then joins your trust list |

**Multi-wallet plans.** One plan can span several execution wallets. Each step is signed by the wallet it names, and the output of one wallet's step can feed another's. One confirmation for the whole thing.

**Real state, not a fixed list.** Balances come from Alchemy token discovery, so every ERC-20 a wallet has touched is seen, not one hardcoded stablecoin. Likely spam and phishing tokens are filtered out before anything is shown or planned against. Tokens can be given as a curated symbol or as any raw ERC-20 address, with decimals resolved live.

**Live yield.** "The highest-yielding Aave market" is answered by reading Aave V3 reserve data directly from each chain's Pool contract, not by a model's memory.

**Positions.** Aave positions and health factors are read live per wallet and chain.

## Automations

Say it in the chat. Waypoint drafts a typed rule, you confirm once, and it runs without you.

| Type | Trigger | Action |
|---|---|---|
| **DCA buy** | A schedule | Buy an asset with another |
| **Health-factor repay** | Aave health factor below your threshold | Repay a percentage of the current debt |

- **Schedules:** first buy immediately, after N minutes, at a daily UTC time, or every N minutes after the last successful buy.
- **Stop conditions:** number of transactions, USD spent, token amount spent, or days elapsed.
- **Monitor:** a background loop checks every active rule every 60 seconds and signs with the rule's execution wallet.
- **History:** every attempt, success or failure, is recorded with tx hash, gas, amounts and error, and shown in the Automations tab.
- **Back in your chat:** outcomes are posted into the conversation that created the rule, so they are there even if the browser was closed.
- **Control:** pause, resume, check now, or delete any rule.

## Memory and knowledge

**Memory.** Four layers. L0 raw conversation turns, L1 typed atoms (preferences, constraints, events) searchable with SQLite FTS5, L2 scenario summaries, L3 a persona. L2 and L3 are injected every turn; L0 and L1 are searched when a specific fact is needed. Extraction runs in the background after each turn.

**Execution knowledge base.** A small corpus of facts, retrieved by keyword and injected only when relevant. It holds the real bugs hit while building this, and a catalog of external data sources. Examples:

- A wallet with zero native balance cannot pay gas even to move an ERC-20, and the top-up may not be visible on the next RPC read, so poll until it is.
- An Aave aToken's decimals always equal its underlying asset's.
- Cross-chain arrival is confirmed from the bridge's own status API, never by diffing a balance.
- Crypto slang differs by community and language. "U" or "刀" can mean dollars and "大饼" means Bitcoin. The model reads it in context.
- Dollar amounts are converted with a live price, never a remembered one.

## Wallets, accounts and custody

**Accounts.** Email registration or Google sign-in creates the account. Wallets are linked to it with SIWE (Sign-In With Ethereum, one-time nonce). Sessions are JWT cookies.

| Wallet | Custody |
|---|---|
| **Generated execution wallet** | Custodial. Created through Privy. Signing authority sits with Waypoint's Authorization Key, which is what lets automations run with nobody present. Keys are held by Privy with Shamir sharding inside AWS Nitro Enclaves. |
| **Imported execution wallet** | You paste a private key once. It is HPKE-encrypted before it leaves the process and never stored in plaintext by Waypoint. After import it is custodial like the above. |
| **Linked browser wallet** | Non-custodial. Waypoint builds and simulates each step; your wallet signs it. No key ever reaches the server. |

Execution wallets can be exported back to self-custody at any time. Execution wallets can be renamed, so you can say "Execution Wallet 2" or your own label.

`backend/src/delegation/` contains a working EIP-7702 + MetaMask Delegation Framework implementation, verified on Base mainnet with a throwaway account. It is not exposed in the app yet.

## Execution guarantees

- Every step is simulated with `eth_call` before signing. A transaction that would revert is never sent.
- Steps run in order and stop at the first failure. Dependent steps never run on a failed one.
- Amounts are measured, not estimated: a step's real output is decoded from that transaction's own Transfer logs.
- Cross-chain arrival is confirmed through the bridge's own status endpoint, then read from the destination transaction.
- The signer of a step must be the wallet the plan declared for it.
- Unfamiliar `custom_call` targets require explicit confirmation.

## API

The chat UI is one client of this API. A developer calling it directly gets the same behavior.

| Group | Endpoints |
|---|---|
| Auth | `GET /auth/config` · `POST /auth/check-email` · `/register` · `/login-email` · `/google` · `GET /auth/nonce` · `POST /auth/login` (SIWE) · `/link-wallet` · `/logout` · `GET /auth/me` |
| Chat | `POST /chat` · `POST /chat/stream` (SSE) · `GET /chat/sessions` · `GET/DELETE /chat/sessions/:id` |
| Planning | `POST /plan` (goal in, plan out, no execution) |
| Execution | `POST /execute` · `POST /execute/stream` (SSE) |
| Linked-wallet signing | `POST /execute/client/build-step` · `/wait-tx` · `/confirm-step` |
| Wallets | `GET /wallet/portfolio` · `/wallet/defi-positions` · `/wallet/health-factor` · `GET/POST /wallet/execution` · `POST /wallet/execution/import` · `/:id/rename` · `/:id/export` |
| Automations | `POST /triggers` · `POST /chat/automations/confirm` · `GET /triggers` · `POST /triggers/:id/active` · `/check` · `DELETE /triggers/:id` · `GET /triggers/:id/executions` |
| Trust list | `GET /trust` · `POST /trust/revoke` |
| Meta | `GET /chains` · `GET /health` |

## Tech stack

TypeScript · Express · viem · zod · better-sqlite3 (FTS5) · SIWE · Privy · Alchemy · LI.FI · Relay · Enso · OKX DEX API · Aave V3 · MetaMask Smart Accounts Kit · OpenAI-compatible model APIs

## Project structure

```
backend/src/
  chat.ts            orchestrates one conversation turn across the agents
  agents/            triage, readiness, automation intent, review panel
  goalParser.ts      Intent agent
  planner.ts         Planner agent and deterministic plan validation
  orchestrator.ts    turns a plan into transactions: simulate, sign, execute, verify
  execClient.ts      the same flow for linked wallets that sign in the browser
  adapters/          Enso, OKX, LI.FI, Relay, Alchemy, Aave yield and health factor, prices
  chains/            one file per chain
  customCall/        generic ABI encoding and the trust list
  triggers/          automations: monitor loop, DCA, repay, stop conditions
  memory/            four-layer memory
  knowledge/         execution knowledge base
  wallets/           Privy execution wallets and wallet store
  accounts/          email, Google and SIWE auth
  delegation/        EIP-7702 + MetaMask delegation module
frontend/            index.html (landing), app.html (app UI)
logo/                brand assets
```

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

Other scripts: `npm run demo -- "<goal>"` runs state, goal parsing and planning end to end without a server. `npm run compare:swap-providers` compares Enso and OKX routes on the same input without signing anything.

`backend/.env.example` lists every variable: a main model and a separate review model, execution providers, data providers, auth, and Privy.

## Direction

- **More automations on the same engine:** price-triggered take-profit and stop-loss, portfolio rebalancing, yield migration, scheduled consolidation with thresholds.
- **Route comparison across providers:** pick the best quote instead of a fixed order. The comparison tool already benchmarks Enso against OKX.
- **More chains and protocols:** a chain is one file and a protocol is one adapter.
- **Non-custodial delegated execution:** wire the delegation module into the app.
- **Waypoint as an API** for wallets and apps that want an execution agent without building one.
