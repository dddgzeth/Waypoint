# Waypoint

[English](README.md) | **中文**

目标驱动的跨链执行 agent。用自然语言说出目标，Waypoint 规划多步骤执行方案，由独立模型对照你的真实链上余额校验，每笔交易签名前先模拟，你确认一次后真实执行。

- 演示视频：https://youtu.be/bbQQfdj6URM
- 在线体验：https://waypoint.cjlin.com

> "把执行钱包 1、2、3 在所有支持的链上的资产，全部归集到执行钱包 1，换成 ETH，存入收益最高的 Aave 市场。"

一句话，一次确认。Waypoint 读取三条链上的三个钱包，按需跨链、换币，最后存入当前收益最高的 Aave 市场。

## 要解决的问题

人还在给自己的链上资产当路由引擎。资产分散在多条链上，手动操作的每一步都可能不可逆：跨错网络、滑点设置不当、无限额度授权。现有工具要么一次只做一步，要么是固定模板，无法跨步骤、跨链推理。

## 能力

**8 种动作：** `transfer`、`swap`、`bridge`、`cross_chain_swap`、`protocol_supply`、`protocol_withdraw`、`protocol_borrow`（Aave V3）、`custom_call`。

- 同链 swap：Enso 和 OKX DEX 聚合器。由 `SAME_CHAIN_SWAP_PRIMARY`（默认 `enso`，也可设为 `okx`）决定谁优先，另一个自动作为备选。
- 跨链：LI.FI 或 Relay。
- Aave 存款、取款、借款：直接调用 Aave Pool 合约。
- `custom_call`：对单条链上任意合约、任意函数做通用 ABI 编码。账号没用过的 `(合约, 函数)` 组合需要明确确认。
- 代币：预置符号，或任意 ERC-20 合约地址。

**多钱包计划：** 一个计划可以跨多个执行钱包，每一步由其指定的钱包签名，一次确认。

**自然语言自动化：** "如果执行钱包 1 在 Arbitrum 上的 Aave 健康因子跌破 1.5，就偿还 50% 的 USDC 债务。" Waypoint 生成类型化草案，你确认一次，后台监控循环在链上执行。支持 DCA（灵活排程、停止条件）和健康因子还款。

**实时最优收益：** 遇到"收益最高的 Aave 市场"，会跨候选链实时查询收益。

## 架构

七个职责单一的 agent，每个都是独立的模型调用，有自己的 system prompt 和经过 schema 校验的输出。

```
Triage → Readiness → Automation Intent → Intent → Planner
                                                     │
                            ┌────────────────────────┴───────┐
                            ▼                                ▼
                    Goal-Match 复审                  Feasibility 复审
                    （独立的模型/提供方）             （独立的模型/提供方）
```

1. **Triage**：这个请求需不需要真实余额？
2. **Readiness**：信息够不够行动？不够就问一个具体的澄清问题。
3. **Automation Intent**：是不是周期性或条件触发的请求？是的话生成类型化草案，仍需你确认。
4. **Intent**：把自然语言和真实链上状态解析成结构化目标。
5. **Planner**：生成带依赖关系的执行计划，再用确定性代码校验。
6. **Goal-Match** 和 7. **Feasibility**：跑在单独配置的模型上的独立复审。计划是否对应目标？对照真实余额能否跑通？

语言层面的判断交给带好上下文的模型；硬约束（gas 计算、签名者身份、步骤依赖）留在确定性代码里。开发中真实踩过的坑存进执行知识库（SQLite FTS5），按需检索，旁边还有分层记忆系统。

**执行：** 每一步签名前先用 `eth_call` 模拟；按顺序执行，失败即停；产出金额从真实的 Transfer 日志解码；跨链到账通过桥自己的状态接口确认。

## 钱包与托管

| 路径 | 托管方式 |
|---|---|
| 生成执行钱包 | 托管制。通过 Privy 创建，签名权限在 Waypoint 的 Authorization Key。密钥由 Privy 的 Shamir 分片和 AWS Nitro Enclaves 保护。 |
| 导入执行钱包 | 私钥在离开进程前用 HPKE 加密，不落地明文。导入后同上，托管制。 |
| 连接浏览器钱包（SIWE） | 非托管。只有签名，没有私钥。 |
| EIP-7702 + MetaMask 委托 | 非托管。给中继钱包范围窄、可过期、限定范围的委托。 |

执行钱包可以随时导出私钥，回到自托管。

## 技术栈

TypeScript、Express、viem、zod、better-sqlite3、SIWE、Privy、MetaMask Smart Accounts Kit、LI.FI、Relay、Enso、OKX DEX API、Aave V3、Alchemy、兼容 OpenAI 的模型 API。

## 本地运行

```bash
cd backend
cp .env.example .env     # 填入你自己的 key
npm install
npm run dev              # http://127.0.0.1:8787
```

另开一个终端：

```bash
cd frontend
python3 -m http.server 3005
# 打开 http://127.0.0.1:3005/app.html   （落地页：index.html）
```

## 目录

```
backend/    API、agents、planner、orchestrator、适配器、自动化
frontend/   index.html（落地页）、app.html（应用界面）
logo/       品牌素材
```
