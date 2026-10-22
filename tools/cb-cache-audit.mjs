#!/usr/bin/env node
// codebuddy prompt-cache audit. Read-only: it inspects pi session files, the
// codebuddy session JSONL, and codebuddy-sdk.log if it exists. It never writes
// to pi config, never touches a provider, and never affects codex.
//
//   node tools/cb-cache-audit.mjs              # summary
//   node tools/cb-cache-audit.mjs --log        # also parse codebuddy-sdk.log
//
// What it can and cannot tell you:
//
//   can    cache read share per provider, per turn index, and the
//          uncached-input / cache-read ratio (a duplication signature)
//   can    duplicate turns inside codebuddy session files
//   cannot tell you *why* codebuddy sits at ~49%. That needs the per-request
//          log: run pi once with CODEBUDDY_SDK_DEBUG=1 and this script will
//          report cachePct and the REUSE/REBUILD path counts.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const PI_SESSIONS = join(homedir(), ".pi", "agent", "sessions");
const CB_PROJECTS = join(homedir(), ".codebuddy", "projects");
const CB_LOG = join(homedir(), ".pi", "agent", "codebuddy-sdk.log");

function walkJsonl(dir, acc = []) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkJsonl(path, acc);
    else if (name.endsWith(".jsonl")) acc.push(path);
  }
  return acc;
}

function readLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "-");

// --- 1. per-provider usage from pi sessions ---------------------------------
function piUsage() {
  const byProvider = new Map();
  const byTurn = new Map();

  for (const file of walkJsonl(PI_SESSIONS)) {
    const assistant = [];
    for (const line of readLines(file)) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const m = entry.message;
      if (entry.type !== "message" || m?.role !== "assistant" || !m.usage) continue;
      const prompt = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
      if (prompt > 0) assistant.push(m);
    }

    assistant.forEach((m, index) => {
      const key = `${m.provider}/${m.model}`;
      const bucketKey = index === 0 ? "1" : index < 4 ? "2-4" : index < 10 ? "5-9" : index < 30 ? "10-29" : "30+";
      for (const [map, k] of [
        [byProvider, key],
        [byTurn, key + "|" + bucketKey],
      ]) {
        const b = map.get(k) ?? { n: 0, prompt: 0, read: 0, write: 0, input: 0 };
        b.n += 1;
        b.prompt += m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
        b.read += m.usage.cacheRead;
        b.write += m.usage.cacheWrite;
        b.input += m.usage.input;
        map.set(k, b);
      }
    });
  }

  return { byProvider, byTurn };
}

// --- 2. duplicate turns inside codebuddy session files ----------------------
function codebuddyDuplicates() {
  let assistant = 0;
  let duplicates = 0;
  const files = walkJsonl(CB_PROJECTS);
  for (const file of files) {
    const seen = new Set();
    for (const line of readLines(file)) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "message" || entry.role !== "assistant") continue;
      assistant += 1;
      const text = Array.isArray(entry.content) ? entry.content.map((b) => b.text ?? "").join("") : String(entry.content ?? "");
      if (text.length < 30) continue;
      if (seen.has(text)) duplicates += 1;
      else seen.add(text);
    }
  }
  return { files: files.length, assistant, duplicates };
}

// --- 3. per-request log (only with CODEBUDDY_SDK_DEBUG=1) ------------------
function parseSdkLog() {
  if (!existsSync(CB_LOG)) return { available: false };
  const lines = readLines(CB_LOG);
  const cachePct = [];
  const paths = { reuse: 0, rebuild: 0, "clean-start": 0 };
  for (const line of lines) {
    const hit = line.match(/cachePct=(\d+)%/);
    if (hit) cachePct.push(Number(hit[1]));
    const path = line.match(/syncResult: path=([a-z-]+)/);
    if (path && path[1] in paths) paths[path[1]] += 1;
  }
  return { available: cachePct.length > 0 || paths.reuse + paths.rebuild > 0, lines: lines.length, cachePct, paths };
}

// --- report ----------------------------------------------------------------
const { byProvider, byTurn } = piUsage();
const rows = [...byProvider.entries()].sort((a, b) => b[1].input - a[1].input);

console.log("## pi sessions — per provider (sorted by uncached input)\n");
console.log("provider/model".padEnd(36), "turns".padStart(7), "hit%".padStart(7), "uncachedInput".padStart(14), "cacheRead".padStart(12), "in/read".padStart(8));
for (const [key, v] of rows) {
  console.log(
    key.padEnd(36),
    String(v.n).padStart(7),
    pct(v.read, v.prompt).padStart(7),
    String(v.input).padStart(14),
    String(v.read).padStart(12),
    (v.input / Math.max(1, v.read)).toFixed(2).padStart(8),
  );
}
console.log("\nin/read ≈ 1.0 with cacheWrite ≈ 0 is the duplication signature: the prompt carries");
console.log("about as much cached as uncached content, and nothing is ever written to the cache.");

const codebuddy = rows.filter(([k]) => k.startsWith("codebuddy/"));
if (codebuddy.length) {
  console.log("\n## codebuddy — hit rate by turn index\n");
  const buckets = ["1", "2-4", "5-9", "10-29", "30+"];
  const models = codebuddy.map(([k]) => k);
  console.log("bucket".padEnd(8), models.map((m) => m.replace("codebuddy/", "").padStart(12)).join(""));
  for (const b of buckets) {
    const cells = models.map((m) => {
      const v = byTurn.get(m + "|" + b);
      return (v ? pct(v.read, v.prompt) : "-").padStart(12);
    });
    console.log(b.padEnd(8), cells.join(""));
  }
  console.log("\nA flat row means the hit rate does not depend on session length: prompt shape or");
  console.log("orchestration cannot move it. A rising row means cold starts are the cost.");
}

const dup = codebuddyDuplicates();
console.log("\n## codebuddy session files\n");
console.log(`files ${dup.files}, assistant records ${dup.assistant}, duplicated text ${dup.duplicates} (${pct(dup.duplicates, dup.assistant)})`);

const log = parseSdkLog();
console.log("\n## per-request log\n");
if (!log.available) {
  console.log("no cachePct / syncResult lines in " + CB_LOG);
  console.log("capture them with:  CODEBUDDY_SDK_DEBUG=1 pi");
  console.log("then re-run this script. That is the only data that separates REUSE from REBUILD.");
} else {
  const avg = log.cachePct.reduce((a, b) => a + b, 0) / Math.max(1, log.cachePct.length);
  const min = Math.min(...log.cachePct);
  const max = Math.max(...log.cachePct);
  console.log(`cachePct: n=${log.cachePct.length} avg=${avg.toFixed(1)}% min=${min}% max=${max}%`);
  console.log(`syncResult: reuse=${log.paths.reuse} rebuild=${log.paths.rebuild} clean-start=${log.paths["clean-start"]}`);
  if (log.paths.rebuild > log.paths.reuse) {
    console.log("→ REBUILD dominates. Each rebuild rewrites the session file, so the provider sees a");
    console.log("  new transcript instead of a continuation. That is the codebuddy-side defect to fix.");
  } else if (log.paths.reuse > log.paths.rebuild) {
    console.log("→ REUSE dominates, so the transcript is being continued. The flat hit rate then comes");
    console.log("  from the provider or proxy, not from the session sync.");
  }
}
