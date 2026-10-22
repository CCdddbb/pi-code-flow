/**
 * code-flow — a gated coding pipeline on top of pi-subagents.
 *
 * Overlay design: nothing in pi-subagents is modified. This extension only
 *   - owns the run state and the two human gates,
 *   - launches the shipped workflow scripts (plan.js / apply.js),
 *   - refuses to unlock implementation before the plan is approved.
 *
 * Commands:
 *   /flow plan <target>   recon + plan, stops for review
 *   /flow approve         accept the plan (gate 1) and unlock apply
 *   /flow reject [note]   discard the plan
 *   /flow apply           implement -> gate -> single-session review -> fix loop
 *   /flow status          current phase, artifacts, verify command
 *   /flow stats           prompt-cache hit rate for this project's sessions
 *   /flow reset           clear state for this project
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Phase = "idle" | "planning" | "awaiting_approval" | "approved" | "applying" | "done" | "failed";

interface RunRecord {
  at: string;
  ok?: boolean;
  note?: string;
}

interface FlowState {
  phase: Phase;
  target?: string;
  verify?: string;
  updatedAt?: string;
  approvedAt?: string;
  rejectedAt?: string;
  note?: string;
  runs: RunRecord[];
}

const EMPTY_STATE: FlowState = { phase: "idle", runs: [] };
const STATUS_KEY = "code-flow";

// Long prompt-cache retention. Children inherit this environment variable, and
// the default short retention expires while a pipeline child is still working,
// which turns the parent's next turn into a full-price re-send. Set once, before
// any request; an explicit value from the operator always wins.
if (!process.env.PI_CACHE_RETENTION) process.env.PI_CACHE_RETENTION = "long";

interface SessionUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface CacheStat {
  turns: number;
  prompt: number;
  read: number;
  write: number;
  input: number;
}

const EMPTY_CACHE_STAT: CacheStat = { turns: 0, prompt: 0, read: 0, write: 0, input: 0 };

function flowsDir(): string {
  try {
    return fileURLToPath(new URL("../code-flow/flows/", import.meta.url));
  } catch {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    return join(agentDir, "code-flow", "flows") + "/";
  }
}

function flowDir(cwd: string): string {
  return join(cwd, ".pi", "flow");
}

function statePath(cwd: string): string {
  return join(flowDir(cwd), "state.json");
}

function readState(cwd: string): FlowState {
  try {
    const raw = readFileSync(statePath(cwd), "utf8");
    const parsed = JSON.parse(raw) as Partial<FlowState>;
    return { ...EMPTY_STATE, ...parsed, runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function writeState(cwd: string, state: FlowState): FlowState {
  const next: FlowState = { ...state, updatedAt: new Date().toISOString() };
  const dir = flowDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(cwd), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function readArtifact(cwd: string, name: string, maxChars = 4000): string | undefined {
  const path = join(flowDir(cwd), name);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text;
}

function detectVerify(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts || {};
    if (scripts.test) return "npm test";
    if (scripts.check) return "npm run check";
    if (scripts.verify) return "npm run verify";
  } catch {
    /* no package.json */
  }
  if (existsSync(join(cwd, "pyproject.toml"))) return "pytest -q";
  if (existsSync(join(cwd, "Makefile"))) return "make check";
  return undefined;
}

function sessionsDir(cwd: string): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const key = "--" + cwd.replace(/^\/+/, "").replace(/[\\/]+/g, "-") + "--";
  return join(agentDir, "sessions", key);
}

function pct(part: number, whole: number): string {
  return whole > 0 ? ((part / whole) * 100).toFixed(1) + "%" : "-";
}

/**
 * Cache read share of prompt tokens, the same ratio cc-switch and pi's footer
 * show. Counted per assistant message so a session that mostly re-sends cached
 * history scores high and a session made of cold starts scores low.
 */
function collectCacheStats(cwd: string): { files: { name: string; stat: CacheStat }[]; total: CacheStat } {
  const dir = sessionsDir(cwd);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    names = [];
  }

  const files: { name: string; stat: CacheStat }[] = [];
  for (const name of names) {
    const stat: CacheStat = { ...EMPTY_CACHE_STAT };
    let raw = "";
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let entry: { type?: string; message?: { role?: string; usage?: SessionUsage } };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      const usage = entry.message?.usage;
      if (entry.type !== "message" || entry.message?.role !== "assistant" || !usage) continue;
      const prompt = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
      if (prompt <= 0) continue;
      stat.turns += 1;
      stat.prompt += prompt;
      stat.read += usage.cacheRead || 0;
      stat.write += usage.cacheWrite || 0;
      stat.input += usage.input || 0;
    }
    if (stat.turns > 0) files.push({ name, stat });
  }

  const total = files.reduce<CacheStat>(
    (acc, file) => ({
      turns: acc.turns + file.stat.turns,
      prompt: acc.prompt + file.stat.prompt,
      read: acc.read + file.stat.read,
      write: acc.write + file.stat.write,
      input: acc.input + file.stat.input,
    }),
    { ...EMPTY_CACHE_STAT },
  );

  return { files, total };
}

function statsText(cwd: string): string {
  const { files, total } = collectCacheStats(cwd);
  if (files.length === 0) {
    return [
      "本项目还没有可统计的会话记录。",
      sessionsDir(cwd),
      "注意：子代理会话不写入这里，/flow stats 统计的是本项目主会话自身。",
    ].join("\n");
  }

  const lines = [
    `cache hit:      ${pct(total.read, total.prompt)}  (${total.read.toLocaleString()} / ${total.prompt.toLocaleString()} prompt tokens)`,
    `uncached input: ${total.input.toLocaleString()}`,
    `cache write:    ${total.write.toLocaleString()}`,
    `turns:          ${total.turns.toLocaleString()}`,
    "",
    "最近会话：",
  ];
  for (const file of files.slice(-5).reverse()) {
    const short = file.name.replace(/^.*_/, "").replace(/\.jsonl$/, "").slice(0, 8);
    lines.push(
      `  ${short}  ${String(file.stat.turns).padStart(4)} turns  hit ${pct(file.stat.read, file.stat.prompt).padStart(6)}`,
    );
  }
  lines.push(
    "",
    "判读：命中率是会话长度的函数，不是提示词写法的函数。本机实测",
    "第1轮 9.5% / 2-4轮 42% / 5-9轮 77% / 10-29轮 87% / 30+轮 91%。",
    "短会话多、每个都从冷前缀开始，就是命中率低的主因。",
  );
  return lines.join("\n");
}

function statusText(state: FlowState): string {
  const target = state.target ? ` · ${state.target.slice(0, 40)}` : "";
  return `flow: ${state.phase}${target}`;
}

function setStatus(ctx: ExtensionContext | ExtensionCommandContext, state: FlowState): void {
  try {
    ctx.ui.setStatus(STATUS_KEY, statusText(state));
  } catch {
    /* non-TUI mode */
  }
}

function planPrompt(target: string, cwd: string, verify: string | undefined): string {
  const args = JSON.stringify({ target, cwd });
  return [
    "Run the code-flow PLAN stage. Do exactly this and nothing more:",
    "",
    "1. Call the `subagent` tool once:",
    "   workflow: " + JSON.stringify(join(flowsDir(), "plan.js")),
    "   args: " + args,
    "   async: false",
    "2. Do not edit files. Do not start implementing. Do not launch other subagents.",
    "3. Then reply in at most 8 lines: whether the run succeeded, the paths",
    "   .pi/flow/map.md and .pi/flow/plan.md, the goal sentence from the plan,",
    "   and the top risks. The operator will review the plan next.",
    verify ? "4. Verification command detected for this repo: " + verify : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function applyPrompt(plan: string, target: string | undefined, verify: string | undefined, cwd: string): string {
  const args = JSON.stringify({
    plan,
    target: target || "",
    verify: verify || "",
    maxRounds: 2,
    cwd,
  });
  return [
    "The operator approved the plan. Run the code-flow APPLY stage:",
    "",
    "1. Call the `subagent` tool once:",
    "   workflow: " + JSON.stringify(join(flowsDir(), "apply.js")),
    "   args: " + args,
    "   async: false",
    "2. Do not commit, push, or amend anything. Do not run a second workflow.",
    "3. Then reply in at most 10 lines: verdict, rounds used, files changed,",
    "   which artifacts under .pi/flow/ to read, and anything still MUST_FIX.",
  ].join("\n");
}

function describe(cwd: string, state: FlowState): string {
  const lines = [
    `phase:   ${state.phase}`,
    `target:  ${state.target || "-"}`,
    `verify:  ${state.verify || "(none detected — review children only)"}`,
    `updated: ${state.updatedAt || "-"}`,
    `state:   ${statePath(cwd)}`,
  ];
  if (state.approvedAt) lines.push(`approved: ${state.approvedAt}`);
  if (state.rejectedAt) lines.push(`rejected: ${state.rejectedAt}`);
  if (state.note) lines.push(`note:     ${state.note}`);
  for (const name of ["map.md", "plan.md", "impl.md", "review-r1.md", "review-r2.md", "fix-r1.md"]) {
    const path = join(flowDir(cwd), name);
    if (existsSync(path)) lines.push(`artifact: ${path}`);
  }
  const runs = state.runs.slice(-3);
  if (runs.length) {
    lines.push("recent subagent runs:");
    for (const run of runs) lines.push(`  ${run.at} ok=${run.ok === undefined ? "?" : run.ok}`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("flow", {
    description: "Gated coding pipeline: /flow plan <目标> | approve | apply | status | stats | reset",
    getArgumentCompletions(prefix: string) {
      const words = ["plan", "approve", "reject", "apply", "status", "stats", "reset"];
      const hits = words.filter((w) => w.startsWith(prefix.trim()));
      return hits.length ? hits.map((w) => ({ value: w, label: w })) : null;
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      const cwd = ctx.cwd;
      const [verb = "status", ...rest] = args.trim().split(/\s+/);
      const tail = rest.join(" ").trim();
      let state = readState(cwd);

      if (verb === "plan") {
        if (!tail) {
          ctx.ui.notify("用法: /flow plan <一句话目标>", "warning");
          return;
        }
        const verify = detectVerify(cwd);
        state = writeState(cwd, {
          phase: "planning",
          target: tail,
          verify,
          runs: [],
          updatedAt: undefined,
        });
        setStatus(ctx, state);
        ctx.ui.notify(`code-flow: 规划中… (verify: ${verify || "未检测到"})`, "info");
        pi.sendUserMessage(planPrompt(tail, cwd, verify));
        return;
      }

      if (verb === "approve") {
        if (state.phase !== "awaiting_approval" && state.phase !== "planning") {
          ctx.ui.notify(`当前 phase=${state.phase}，没有待审的计划。先 /flow plan <目标>`, "warning");
          return;
        }
        const plan = readArtifact(cwd, "plan.md", 6000);
        if (!plan) {
          ctx.ui.notify("找不到 .pi/flow/plan.md，规划可能未完成。", "error");
          return;
        }
        const ok = await ctx.ui.confirm(
          "计划审阅（gate 1）",
          plan + "\n\n批准后将解锁 /flow apply。",
        );
        if (!ok) {
          state = writeState(cwd, { ...state, note: "plan not approved" });
          setStatus(ctx, state);
          ctx.ui.notify("未批准，apply 保持锁定。", "warning");
          return;
        }
        state = writeState(cwd, { ...state, phase: "approved", approvedAt: new Date().toISOString() });
        setStatus(ctx, state);
        ctx.ui.notify("计划已批准。下一步: /flow apply", "info");
        return;
      }

      if (verb === "reject") {
        state = writeState(cwd, {
          ...state,
          phase: "idle",
          rejectedAt: new Date().toISOString(),
          note: tail || "rejected by operator",
        });
        setStatus(ctx, state);
        ctx.ui.notify("计划已废弃。", "info");
        return;
      }

      if (verb === "apply") {
        if (state.phase !== "approved" || !state.approvedAt) {
          ctx.ui.notify(`apply 被 gate 拦住：phase=${state.phase}。先 /flow approve`, "error");
          return;
        }
        const plan = readArtifact(cwd, "plan.md", 12000);
        if (!plan) {
          ctx.ui.notify("找不到 .pi/flow/plan.md。", "error");
          return;
        }
        state = writeState(cwd, { ...state, phase: "applying" });
        setStatus(ctx, state);
        ctx.ui.notify(`执行中，gate = ${state.verify || "无（仅评审）"}`, "info");
        pi.sendUserMessage(applyPrompt(plan, state.target, state.verify, cwd));
        return;
      }

      if (verb === "stats") {
        ctx.ui.notify(statsText(cwd), "info");
        return;
      }

      if (verb === "reset") {
        state = writeState(cwd, { ...EMPTY_STATE });
        setStatus(ctx, state);
        ctx.ui.notify("code-flow 状态已清空（产物文件保留）。", "info");
        return;
      }

      ctx.ui.notify(describe(cwd, state), "info");
    },
  });

  // Gate 2 enforcement: the model cannot start the apply workflow unless the
  // operator approved the plan in this project.
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const workflow = typeof event.input?.workflow === "string" ? event.input.workflow : "";
    if (!workflow.includes("apply.js")) return;
    const state = readState(ctx.cwd);
    if (state.phase === "approved" && state.approvedAt) return;
    return {
      block: true,
      reason:
        "code-flow: apply.js is gated. The operator must approve the plan first (/flow approve). " +
        `Current phase: ${state.phase}.`,
    };
  });

  // Track subagent runs so /flow status reflects what actually happened.
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const state = readState(ctx.cwd);
    if (state.phase === "idle") return;
    const record: RunRecord = { at: new Date().toISOString(), ok: !event.isError };
    let next: FlowState = { ...state, runs: [...state.runs, record].slice(-20) };
    if (state.phase === "planning" && !event.isError) {
      next = { ...next, phase: "awaiting_approval" };
    } else if (state.phase === "applying" && !event.isError) {
      next = { ...next, phase: "done" };
    } else if (event.isError) {
      next = { ...next, phase: "failed" };
    }
    writeState(ctx.cwd, next);
    setStatus(ctx, next);
  });

  pi.on("session_start", (_event, ctx) => {
    const state = readState(ctx.cwd);
    if (state.phase !== "idle") setStatus(ctx, state);
  });
}
