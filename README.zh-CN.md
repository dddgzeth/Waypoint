# Waypoint

[English](README.md) | **中文**

### 你的个人链上 agent。

说出你想在链上完成的事。Waypoint 规划多步骤、跨链的执行方案，每笔交易签名前先模拟，你确认一次后执行。它记得你，看得到你持有的一切，你不在的时候也一直盯着。

- 演示视频：https://youtu.be/bbQQfdj6URM
- 在线体验：https://waypoint.cjlin.com

## 愿景

终极目标是做你的个人链上 agent：一个 agent 替你处理你用到的所有链和钱包，就像一个好助理替你打理你的各个账户。

| 它... | 怎么做到 |
|---|---|
| **认识你** | 分层记忆你的偏好、约束和历史，不用每次重复说明。 |
| **看得到一切** | 读取你在 Ethereum、Base、Arbitrum、Polygon 上所有执行钱包和关联钱包，真实的代币发现，实时的 DeFi 头寸。 |
| **替你行动** | 把目标变成带依赖关系的多步骤跨链计划，你确认一次就执行。 |
| **一直盯着** | 自动化在后台运行，条件满足时在链上行动，并在你的对话里汇报。 |

这个仓库是可运行的基础：agent 流水线、执行引擎、钱包、记忆、自动化和应用界面。

## 你可以这样说

```
把执行钱包 1、2、3 在所有支持的链上的资产，全部归集到执行钱包 1，
换成 ETH，存入收益最高的 Aave 市场。

把我在 Base 上 Aave 里的 USDC 取出来，转 100 到 0x...

在 Arbitrum 上用我的 Aave 头寸借 1,000 USDC，换成 ETH。

用执行钱包 1 每天 UTC 09:00 买 5 美元的 ETH，买 10 次。

如果执行钱包 1 在 Arbitrum 上的 Aave 健康因子跌破 1.5，
自动偿还 50% 的 USDC 债务。
```

有歧义时 Waypoint 只问一个澄清问题，展示完整计划，你确认后才执行。

## 工作原理

```
消息
  │
  ▼
Triage ─► Readiness ─► Automation Intent ─► Intent ─► Planner ─► 计划展示给你
                                                         │              │
                                                         ▼              ▼
                                            Goal-Match + Feasibility    确认
                                            （独立模型）                   │
                                                                          ▼
                                                     模拟 ─► 签名 ─► 执行 ─► 校验
```

七个职责单一的 agent。每个都是独立的模型调用，有自己的 system prompt 和经过 schema（zod）校验的输出。

| # | Agent | 职责 |
|---|---|---|
| 1 | **Triage** | 这个请求需不需要真实余额？不需要就跳过多链读取。 |
| 2 | **Readiness** | 信息够不够行动？不够就问一个具体问题。 |
| 3 | **Automation Intent** | 是不是周期性或条件触发的请求？是的话生成类型化的自动化草案（DCA 或健康因子规则），仍需你确认。 |
| 4 | **Intent** | 把自然语言和真实链上状态解析成结构化目标。只描述你想要什么，不生成交易。 |
| 5 | **Planner** | 生成带依赖关系的计划：每一步的链、资产、金额、来源和目标钱包、走哪个提供方。输出由确定性代码校验。 |
| 6 | **Goal-Match** | 独立复审：计划是否对应解析出的目标？ |
| 7 | **Feasibility** | 独立复审：对照你的真实余额，计划能不能跑通，包括后面每一步的 gas？ |

第 6、7 个 agent 跑在单独配置的模型和网关上，不和 Planner 共享盲点。它们和面向用户的流程并行运行，不增加延迟。

设计原则：语言层面的判断交给带好上下文的模型；硬约束（gas 计算、签名者身份、步骤依赖）留在确定性代码里。

### 每个计划都要过的确定性校验

- 只允许受支持的链和协议。
- 步骤声明的来源钱包必须是真实解析出的地址，且是你指定的钱包之一，不能是标签或占位符。
- 转账只能在同一条链上、同一种资产。跨链转账是先 bridge 再 transfer。
- 步骤的产出只能引用真实存在的步骤。
- Aave 取款留在同一条链，使用底层资产。
- 如果你要的是最优收益，计划必须存入实时查到的最优市场，而不是顺手的市场。
- 计划必须真的从你指定的钱包花钱。
- 原生代币转账按当前 EIP-1559 费率预留 gas。

## 能力

**链：** Ethereum、Base、Arbitrum、Polygon。加一条链就是在 `backend/src/chains/` 下加一个文件，其余全部读取这个注册表。

**8 种动作**

| 动作 | 做什么 | 实现 |
|---|---|---|
| `transfer` | 向任意地址转原生代币或 ERC-20 | viem |
| `swap` | 同链换币 | Enso 和 OKX DEX 聚合器。`SAME_CHAIN_SWAP_PRIMARY`（`enso` 或 `okx`）决定谁先试，另一个自动作为备选 |
| `bridge` | 跨链转移资产 | LI.FI 或 Relay |
| `cross_chain_swap` | 换币和跨链一步完成 | LI.FI 或 Relay |
| `protocol_supply` | 存入 Aave V3 | 直接调用 Aave Pool `supply()` |
| `protocol_withdraw` | 从 Aave V3 取出 | 直接调用 Aave Pool `withdraw()` |
| `protocol_borrow` | 从 Aave V3 借款 | 直接调用 Aave Pool `borrow()` |
| `custom_call` | 单条链上任意合约函数 | 由函数签名做通用 ABI 编码。账号没用过的 `(合约, 函数)` 组合需要明确确认，确认后加入信任列表 |

**多钱包计划。** 一个计划可以跨多个执行钱包。每一步由它指定的钱包签名，一个钱包某一步的产出可以喂给另一个钱包的步骤。整件事一次确认。

**看真实状态，不是固定清单。** 余额来自 Alchemy 的代币发现，钱包碰过的每个 ERC-20 都能看到，不是只有一个写死的稳定币。疑似垃圾币和钓鱼币在展示和规划之前就被过滤。代币可以写预置符号，也可以直接给任意 ERC-20 合约地址，精度实时解析。

**实时收益。** "收益最高的 Aave 市场"是直接读各条链 Aave V3 Pool 合约的储备数据得出的，不靠模型的记忆。早期版本让模型猜过，它选错了链。

**头寸。** 每个钱包在每条链上的 Aave 头寸和健康因子实时读取。

## 自动化

在对话里说出来。Waypoint 生成类型化的规则草案，你确认一次，之后无需你在场。

| 类型 | 触发 | 动作 |
|---|---|---|
| **DCA 定投** | 一个时间表 | 用一种资产买另一种 |
| **健康因子还款** | Aave 健康因子低于你的阈值 | 偿还当前债务的一定比例 |

- **时间表：** 立即首次买入、N 分钟后开始、每天固定 UTC 时间，或者上次成功买入后每隔 N 分钟。
- **停止条件：** 交易笔数、花费的美元总额、花费的代币数量，或经过的天数。
- **监控：** 后台循环每 60 秒检查所有启用的规则，用规则对应的执行钱包签名。
- **历史：** 每次尝试无论成败，都记录 tx hash、gas、金额和错误，显示在 Automations 页面。
- **回到你的对话：** 执行结果会发回创建这条规则的那个对话，即使浏览器关着，回来也能看到。
- **控制：** 任何规则都可以暂停、恢复、立即检查或删除。

## 记忆与知识

**记忆。** 四层。L0 原始对话轮次，L1 类型化的"原子"（偏好、约束、事件），用 SQLite FTS5 检索，L2 场景摘要，L3 用户画像。L2、L3 每轮都注入；L0、L1 在需要具体事实时检索。每轮结束后在后台提取记忆。

**执行知识库。** 一个小型事实语料库，按关键词检索，只在相关时才注入。里面有开发中真实踩过的坑，以及一份外部数据源目录。例如：

- 原生代币余额为零的钱包，连转 ERC-20 的 gas 都付不起；充值的到账在下一次 RPC 读取里未必可见，要轮询直到看到。
- Aave aToken 的精度永远等于底层资产的精度。
- 跨链到账要看桥自己的状态接口，不能靠余额前后差值判断。
- 币圈俗称因社群和语言而异。"U"或"刀"可以指美元，"大饼"指比特币。由模型结合上下文理解。这件事写过正则，反复被新用例打脸，最后删掉了。
- 美元金额用实时价格换算，绝不用记忆里的价格。

## 钱包、账号与托管

**账号。** 邮箱注册或 Google 登录创建账号。钱包用 SIWE（Sign-In With Ethereum，一次性 nonce）关联到账号。会话是 JWT cookie。

| 钱包 | 托管方式 |
|---|---|
| **生成的执行钱包** | 托管制。通过 Privy 创建，签名权限在 Waypoint 的 Authorization Key，这也是自动化能在无人在场时运行的原因。密钥由 Privy 在 AWS Nitro Enclaves 内用 Shamir 分片持有。 |
| **导入的执行钱包** | 你粘贴一次私钥，在离开进程前用 HPKE 加密，Waypoint 从不存明文。导入后同上，托管制。 |
| **关联的浏览器钱包** | 非托管。Waypoint 构建并模拟每一步，由你的钱包签名。私钥不会到达服务器。 |

执行钱包可以随时导出私钥，回到自托管。执行钱包可以重命名，所以你可以说"执行钱包 2"，也可以用自己起的名字。

`backend/src/delegation/` 里有一套可用的 EIP-7702 + MetaMask Delegation Framework 实现，已在 Base 主网用一次性账号验证过，目前还没有接入应用。

## 执行保证

- 每一步签名前先用 `eth_call` 模拟。会 revert 的交易永远不会发出。
- 按顺序执行，遇到第一个失败就停止。依赖失败步骤的后续步骤不会运行。
- 金额是测量的不是估算的：一步的真实产出从这笔交易自己的 Transfer 日志解码。
- 跨链到账通过桥自己的状态接口确认，再从目标链的交易里读取。
- 一步的签名者必须是计划为它声明的那个钱包。
- 不熟悉的 `custom_call` 目标需要明确确认。

## API

聊天界面只是这套 API 的一个客户端，开发者直接调用得到的行为是一样的。

| 分组 | 接口 |
|---|---|
| 认证 | `GET /auth/config` · `POST /auth/check-email` · `/register` · `/login-email` · `/google` · `GET /auth/nonce` · `POST /auth/login`（SIWE）· `/link-wallet` · `/logout` · `GET /auth/me` |
| 对话 | `POST /chat` · `POST /chat/stream`（SSE）· `GET /chat/sessions` · `GET/DELETE /chat/sessions/:id` |
| 规划 | `POST /plan`（输入目标，输出计划，不执行） |
| 执行 | `POST /execute` · `POST /execute/stream`（SSE） |
| 关联钱包签名 | `POST /execute/client/build-step` · `/wait-tx` · `/confirm-step` |
| 钱包 | `GET /wallet/portfolio` · `/wallet/defi-positions` · `/wallet/health-factor` · `GET/POST /wallet/execution` · `POST /wallet/execution/import` · `/:id/rename` · `/:id/export` |
| 自动化 | `POST /triggers` · `POST /chat/automations/confirm` · `GET /triggers` · `POST /triggers/:id/active` · `/check` · `DELETE /triggers/:id` · `GET /triggers/:id/executions` |
| 信任列表 | `GET /trust` · `POST /trust/revoke` |
| 元信息 | `GET /chains` · `GET /health` |

## 技术栈

TypeScript · Express · viem · zod · better-sqlite3（FTS5）· SIWE · Privy · Alchemy · LI.FI · Relay · Enso · OKX DEX API · Aave V3 · MetaMask Smart Accounts Kit · 兼容 OpenAI 的模型 API

## 项目结构

```
backend/src/
  chat.ts            编排一轮对话中各 agent 的调用
  agents/            triage、readiness、automation intent、复审面板
  goalParser.ts      Intent agent
  planner.ts         Planner agent 和确定性的计划校验
  orchestrator.ts    把计划变成交易：模拟、签名、执行、校验
  execClient.ts      关联钱包（在浏览器里签名）走的同一套流程
  adapters/          Enso、OKX、LI.FI、Relay、Alchemy、Aave 收益与健康因子、价格
  chains/            每条链一个文件
  customCall/        通用 ABI 编码和信任列表
  triggers/          自动化：监控循环、DCA、还款、停止条件
  memory/            四层记忆
  knowledge/         执行知识库
  wallets/           Privy 执行钱包和钱包存储
  accounts/          邮箱、Google 和 SIWE 认证
  delegation/        EIP-7702 + MetaMask 委托模块
frontend/            index.html（落地页）、app.html（应用界面）
logo/                品牌素材
```

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

其他脚本：`npm run demo -- "<目标>"` 不启动服务，直接跑完状态读取、目标解析和规划。`npm run compare:swap-providers` 用同一输入对比 Enso 和 OKX 的路由，不签名任何交易。

`backend/.env.example` 列出了所有变量：主模型和单独的复审模型、执行提供方、数据提供方、认证和 Privy。

## 方向

- **同一引擎上的更多自动化：** 价格触发的止盈止损、组合再平衡、收益迁移、带阈值的定时归集。
- **跨提供方的路由比价：** 选最优报价，而不是固定顺序。对比工具已经在对比 Enso 和 OKX。
- **更多链和协议：** 一条链是一个文件，一个协议是一个适配器。
- **非托管的委托执行：** 把委托模块接入应用。
- **Waypoint 作为 API：** 给想要执行 agent 但不想自己造的钱包和应用使用。
