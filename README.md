# pi-code-flow

一条带**人工闸门**的通用编码流水线，叠加在 [pi](https://pi.dev) + [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) 之上。

不改上游一行代码：所有编排都是 `pi-subagents` 的 workflow 脚本 + 自定义 agent，所有闸门由一个约 300 行的扩展持有。

```
/flow plan <目标>
  cf-scout   ──► .pi/flow/map.md      只读侦察：入口、测试命令、风险、阻塞问题
  cf-planner ──► .pi/flow/plan.md     可执行计划：步骤 / 验证 / 风险 / 回滚
  ══ gate 1：人工批准（ctx.ui.confirm 展示计划全文）══
/flow apply
  worker          实现 + 宿主侧 verify gate（命令真跑）
  3× cf-reviewer  并行：正确性 / 验证充分性 / 爆炸半径
  cf-reviewer     汇总 → "VERDICT: CLEAN | MUST_FIX"
  cf-fixer        只修 must-fix → 重跑 verify      ← 最多 2 轮
  结束：不 commit、不 push
```

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
├── code-flow/flows/plan.js     # 侦察 + 规划
├── code-flow/flows/apply.js    # 实现 + 并行评审 + 修复循环
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
| `/flow reset` | 清空状态（产物文件保留） |

## 产物

全部落在**当前项目**的 `.pi/flow/`：

```
state.json                  phase / target / verify / 最近 run
map.md                      侦察报告
plan.md                     计划（gate 1 的审阅对象）
impl.md                     实现摘要
review-r1-{correctness,tests,risk}.md
synth-r1.md                 汇总 + VERDICT
fix-r1.md                   修复说明
```

建议加进项目 `.gitignore`：

```
.pi/flow/
```

## 设计取舍

- **不 fork 上游**：`pi-subagents` 升级不会冲突；删掉本目录即完全回退。
- **评审必须给 verdict 行**：`apply.js` 用正则读 `VERDICT: CLEAN|MUST_FIX`，模型无法用"看起来不错"蒙混过关。
- **修复只认 must-fix**：`cf-fixer` 被明确禁止顺手重构，控制 diff 体积。
- **角色提示词写"可证伪"要求**：侦察必须给 `path:line`，计划必须给验证命令，评审必须区分"已验证 / 未验证"。
- **流水线永不 commit**：写完让你自己看 diff、自己提交。

## 已验证

```
subagent action=validate  plan.js   → OK
subagent action=validate  apply.js  → 未批准时被 tool_call 闸门拦下（符合预期）
subagent action=validate  apply.js  → state=approved 后 OK
subagent action=list                → cf-scout / cf-planner / cf-reviewer / cf-fixer 全部 present
node --check (wrapped)              → plan.js / apply.js 语法通过
node --experimental-strip-types     → code-flow.ts 语法通过
```

## 已知边界

- **未跑过完整真实链路**。首次使用建议挑一个小的、有测试的项目。
- 成本约为单次实现的 **3–5 倍**（三路并发评审）。省钱：把 `apply.js` 的 `maxRounds` 调 1，或把 `runs.all` 的评审减到两路。
- `/flow status` 依赖 TUI；`pi -p "/flow status"` 在 print 模式无输出。
- 规划质量取决于仓库是否已有可运行的 verify 命令；没有测试的项目会退化成"只能评审、不能验证"。
- 参数目前写死在脚本里（`maxRounds`、评审路数、模型档位），未抽成配置文件。

## License

MIT
