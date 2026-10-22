// code-flow · PLAN stage
// args: { target: string, cwd?: string, focus?: string, mode?: "merged" | "split" }
//
// Default "merged" mode runs recon and planning inside ONE child session.
//
// Why this is the default: prompt-cache hit rate is a function of session
// length, not of prompt wording. Measured on this machine (9 sessions, 464M
// prompt tokens):
//
//   turn 1    9.5% cache read       turns 5-9     77.0%
//   turns 2-4 42.0%                turns 10-29   87.4%
//                                  turns 30+     91.6%
//
// Two fresh children of ~4 turns each spend almost every token in the 9-42%
// band, and the second child re-sends a prefix the first one already paid for.
// One child that maps the repo and then plans against its own map keeps that
// prefix and turns the plan phase into cache reads.
//
// "split" keeps the old two-child behaviour. Use it when you want the planner
// to cross-check a recon it did not write; it costs two cold prefixes.

const target = typeof args.target === "string" ? args.target.trim() : "";
if (!target) {
  return { ok: false, error: "args.target is required" };
}

const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim() : "";
const scope = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : undefined;
const mode = args.mode === "split" ? "split" : "merged";
const cwdField = scope ? { cwd: scope } : {};

if (mode === "merged") {
  const merged = await runs.run("plan", {
    agent: "cf-planner",
    task: [
      "Task:",
      target,
      focus ? "\nExtra focus from the operator:\n" + focus : "",
      "",
      "You own both phases of this stage, in order, in this session. Do not implement anything.",
      "",
      "Phase 1 — RECON. Map the repository for this task: entry points with path:line,",
      "relevant types/functions and the data flow between them, the exact verify commands",
      "that already exist, and the risks. Write the recon to .pi/flow/map.md.",
      "",
      "Phase 2 — PLAN. Plan against the recon you just did. Do not re-read the repo from",
      "scratch and do not redesign what the recon already settled. Write the plan to",
      ".pi/flow/plan.md using the required sections.",
      "",
      "Reply with at most 8 lines: the goal sentence, step count, risk count, decisions",
      "needed, the verify command, and the two paths you wrote.",
    ]
      .filter(Boolean)
      .join("\n"),
    // cf-planner can write, so it owns plan.md itself. This binding only carries
    // the short summary back to the parent.
    output: ".pi/flow/plan-summary.md",
    ...cwdField,
  });

  if (!merged.ok) {
    return { ok: false, stage: "plan", error: merged.error || "planning failed" };
  }

  return {
    ok: true,
    stage: "plan",
    mode,
    target,
    mapPath: ".pi/flow/map.md",
    planPath: ".pi/flow/plan.md",
    summary: merged.output,
  };
}

const scout = await runs.run("scout", {
  agent: "cf-scout",
  task: [
    "Recon task:",
    target,
    focus ? "\nExtra focus from the operator:\n" + focus : "",
    "",
    "Work in the repository at the current working directory.",
    "Write your report to .pi/flow/map.md, then reply with a 5-line summary.",
  ]
    .filter(Boolean)
    .join("\n"),
  output: ".pi/flow/scout-summary.md",
  ...cwdField,
});

if (!scout.ok) {
  return { ok: false, stage: "scout", error: scout.error || "scout failed" };
}

const plan = await runs.run("plan", {
  agent: "cf-planner",
  task: [
    "Task:",
    target,
    "",
    "Recon report from the previous stage:",
    scout.output || "(empty recon output; read the repo yourself)",
    "",
    "Write the plan to .pi/flow/plan.md, then reply with the 6-line summary.",
  ].join("\n"),
  output: ".pi/flow/plan-summary.md",
  ...cwdField,
});

if (!plan.ok) {
  return { ok: false, stage: "plan", error: plan.error || "planner failed" };
}

return {
  ok: true,
  stage: "plan",
  mode,
  target,
  mapPath: ".pi/flow/map.md",
  planPath: ".pi/flow/plan.md",
  map: scout.output,
  plan: plan.output,
};
