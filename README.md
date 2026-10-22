# pi-code-flow

一条带**人工闸门**的通用编码流水线，叠加在 [pi](https://pi.dev) + [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) 之上。

不改上游一行代码：所有编排都是 `pi-subagents` 的 workflow 脚本 + 自定义 agent，所有闸门由一个约 300 行的扩展持有。

```
/flow plan <目标>
  cf-planner   ──► .pi/flow/map.md + plan.md   一个会话内：先侦察，再拿自己的侦察写计划
  ══ gate 1：人工批准（ctx.ui.confirm 展示计划全文）══
/flow apply
  worker          实现 + 宿主侧 verify gate（命令真跑）
  cf-reviewer     一个会话内三视角：正确性 / 验证充分性 / 爆炸半径，再汇总
                  → "VERDICT: CLEAN | MUST_FIX"
  cf-fixer        只修 must-fix → 重跑 verify          ← 最多 2 轮
  cf-reviewer     第 2 轮起 resume 同一评审会话复审（前缀已缓存）
  结束：不 commit、不 push
```

## 缓存与成本

流水线的钱几乎全花在**冷提示前缀**上。命中率不是提示词写法的函数，是**会话长度**的函数。本机实测（9 个会话，4.64 亿 prompt tokens）：

| 轮次 | 缓存命中 |
|---|---|
| 轮次 | openai-codex | codebuddy |
|---|---|---|
| 第 1 轮 | 0.0% | **47.5%** |
| 2–4 轮 | 44.5% | **46.6%** |
| 5–9 轮 | 81.8% | **45.6%** |
| 10–29 轮 | 94.9% | **48.4%** |
| 30+ 轮 | 97.4% | **49.1%** |

两列是两种完全不同的形状：

- **openai-codex** 是正常的对话前缀缓存，命中率由会话长度决定。一个只跑 3–6 轮的子代理全在 0–44% 这一段。而 `prompt_cache_key` 就是会话 id，所以**每个新子会话都是一次全价冷启动**：系统提示、工具定义、项目上下文、任务文本全部按未缓存计费。
- **codebuddy** 恒定 ~49%，和轮次无关（第 1 轮就有 47.5% 命中）。它走 `api: "codebuddy-sdk"` 自己的通道，命中的是静态前缀而不是对话历史。**这不是流水线能修的**，下面的改动对它无效。

所以本节只对 codex 形状的 provider 成立。

第一版流水线每次要开 8 个子会话（侦察、规划、实现、3×评审、汇总、修复），其中 3 个评审还是**并行**的——它们前缀完全相同，同时发出，于是三个都写缓存、没有一个读到缓存；汇总子代理再把三份评审全文当新输入重发一遍。评审之间共享同一个 agent、模型、系统提示和 diff 摘要，并行换来的并不是独立性，只是四次冷启动。

现在改成两件事：

1. **合并阶段**：侦察+规划一个会话（2 个冷前缀 → 1 个）；三视角评审+汇总一个会话（4 个冷前缀 → 1 个），评审全文不再被重发。
2. **resume 复审**：修复轮次 `resume` 同一个评审会话，前缀已缓存，评审还能对着自己上一轮的问题逐条核对。`resume` 被拒或 run id 失效时自动回落到新会话（`.pi/flow/review-r2-fresh.md`）。

刻意**不**做的事：扩展不设置 `PI_CACHE_RETENTION`。那个变量是进程级的，会改掉本进程内**所有** openai-compatible provider 的请求形状（`prompt_cache_key`、`prompt_cache_retention: "24h"`），包括不是本流水线发起的会话。要长保留就自己 `export PI_CACHE_RETENTION=long`，让这条策略显式属于操作者。

自查：`/flow stats` 用和 cc-switch 同一口径（`cacheRead / (input + cacheRead + cacheWrite)`）统计本项目主会话，并打印上面的分轮曲线做对照。注意它只统计主会话，且不区分 provider。

取舍：合并后侦察与规划不再互相独立复核。要换回两段式（侦察一个子代理、规划另一个）用 `/flow plan` 时传 `mode: "split"`，代价是两个冷前缀。

## 为什么是两阶段

一次性跑完的流水线没有闸门：模型只要"觉得"计划没问题就会开始改文件。这里把规划与实施拆成两条命令，`apply` 在状态机层面检查 `phase === "approved"`，人类审批发生在**命令边界**，而不是提示词里的一句请求。

## 三道闸门

| 闸门 | 机制 | 说明 |
|---|---|---|
| 计划审批 | `/flow approve` → `phase=approved` | 展示 `plan.md` 全文，确认后才解锁 |
| 硬拦截 | `pi.on("tool_call")` | 即使模型自己发起 `apply.js`，未批准时直接 `{block, reason}`，理由回灌给模型 |
| 机器验证 | 子代理挂 `gate: <command>` | 命令失败即该步失败，与子代理的自我陈述无关 |

`verify` 命令自动探测：`package.json` 的 `test` → `check` → `verify`，其次 `pyproject.toml` → `pytest -q`，`Makefile` → `make check`。探测不到时只跑评审，状态里显式写 `verify: (none detected)`，不假装通过。

## 安装

要求：pi 已安装 `pi-subagents`，Node ≥ 22。

```bash
git clone https://github.com/CCdddbb/pi-code-flow.git
cd pi-code-flow

mkdir -p ~/.pi/agent/extensions ~/.pi/agent/agents ~/.pi/agent/code-flow
cp extensions/code-flow.ts        ~/.pi/agent/extensions/
cp agents/cf-*.md                 ~/.pi/agent/agents/
cp -r code-flow/flows             ~/.pi/agent/code-flow/
```

在 pi 里执行 `/reload`，然后 `/flow status` 应显示 `phase: idle`。

目录结构（用户级，所有项目可用）：

```
~/.pi/agent/
├── extensions/code-flow.ts     # /flow 命令、状态栏、两道 gate、状态持久化
├── code-flow/flows/plan.js     # 侦察 + 规划（同一会话）
├── code-flow/flows/apply.js    # 实现 + 三视角评审 + 修复循环（resume 复审）
└── agents/cf-{scout,planner,reviewer,fixer}.md
```

扩展用 `new URL("../code-flow/flows/", import.meta.url)` 定位脚本，因此仓库布局与安装布局必须保持同级关系；改布局请同时改 `flowsDir()`。

## 命令

| 命令 | 行为 |
|---|---|
| `/flow plan <一句话目标>` | 启动规划，完成后 `phase=awaiting_approval` |
| `/flow approve` | 弹出计划全文，确认后 `phase=approved` |
| `/flow reject [理由]` | 废弃计划，`apply` 保持锁定 |
| `/flow apply` | 未批准直接拒绝；批准后跑实现与评审 |
| `/flow status` | 当前 phase、verify 命令、产物路径、最近 run |
| `/flow stats` | 本项目会话的缓存命中率（与 cc-switch 同口径）+ 分轮曲线对照 |
| `/flow reset` | 清空状态（产物文件保留） |

## 产物

全部落在**当前项目**的 `.pi/flow/`：

```
state.json                  phase / target / verify / 最近 run
map.md                      侦察报告（merged 模式下由 cf-planner 写）
plan.md                     计划（gate 1 的审阅对象）
plan-summary.md             规划阶段的简短回执（output 绑定，不覆盖 plan.md）
impl.md                     实现摘要
review-r1.md                三视角评审 + 汇总 + VERDICT
fix-r1.md                   修复说明
review-r2.md                复审（resume 同一评审会话）
```

建议加进项目 `.gitignore`：

```
.pi/flow/
```

## 设计取舍

- **不 fork 上游**：`pi-subagents` 升级不会冲突；删掉本目录即完全回退。
- **阶段合并优先于阶段拆分**：每多一个 fresh 子会话就多一个冷前缀。合并的前提是这些阶段本来就共享同一份上下文（侦察→规划、三视角评审→汇总）。
- **评审必须给 verdict 行**：`apply.js` 用正则读 `VERDICT: CLEAN|MUST_FIX`，模型无法用"看起来不错"蒙混过关；读不到 verdict 行直接判失败，不当成通过。
- **修复只认 must-fix**：`cf-fixer` 被明确禁止顺手重构，控制 diff 体积。
- **角色提示词写"可证伪"要求**：侦察必须给 `path:line`，计划必须给验证命令，评审必须区分"已验证 / 未验证"。
- **流水线永不 commit**：写完让你自己看 diff、自己提交。

## 已验证

```
subagent action=validate  plan.js   → OK
subagent action=validate  apply.js  → 未批准时被 tool_call 闸门拦下（符合预期）
subagent action=validate  apply.js  → state=approved 后 OK
subagent action=list                → cf-scout / cf-planner / cf-reviewer / cf-fixer 全部 present
validateWorkflowScript (官方校验器) → plan.js / apply.js 均 OK（含 runs.run 键名与 portable-async 规则）
node --experimental-strip-types     → code-flow.ts 语法通过
/flow stats                         → 在本项目会话上算出命中率，与 cc-switch 口径一致
```

## 已知边界

- **未跑过完整真实链路**。首次使用建议挑一个小的、有测试的项目。
- 成本约为单次实现的 **2–3 倍**（合并阶段后从 3–5 倍降下来）。再省：把 `apply.js` 的 `maxRounds` 调 1。
- `resume` 复审依赖子会话落盘。run id 失效或 resume 被拒时会自动回落到新评审会话，命中率下降但结果不变。
- `/flow stats` 只统计本项目**主会话**；子代理会话不落盘到该目录，所以流水线自身的命中率要靠 cc-switch 或供应商后台看。
- `/flow status` 依赖 TUI；`pi -p "/flow status"` 在 print 模式无输出。
- 规划质量取决于仓库是否已有可运行的 verify 命令；没有测试的项目会退化成"只能评审、不能验证"。
- 参数目前写死在脚本里（`maxRounds`、评审路数、模型档位），未抽成配置文件。

## License

MIT
