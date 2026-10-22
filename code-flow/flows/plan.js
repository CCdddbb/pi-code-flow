// code-flow · PLAN stage
// args: { target: string, cwd?: string, focus?: string }
//
// Stage 1 recon (read-only) -> stage 2 plan (no implementation).
// Both children write artifacts under .pi/flow/; the parent session stays idle.

const target = typeof args.target === "string" ? args.target.trim() : "";
if (!target) {
  return { ok: false, error: "args.target is required" };
}

const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim() : "";
const scope = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : undefined;

const scout = await runs.run("scout", {
  agent: "cf-scout",
  task: [
    "Recon task:",
    target,
    focus ? `\nExtra focus from the operator:\n${focus}` : "",
    "",
    "Work in the repository at the current working directory.",
    "Write your report to .pi/flow/map.md, then reply with a 5-line summary.",
  ]
    .filter(Boolean)
    .join("\n"),
  output: ".pi/flow/map.md",
  ...(scope ? { cwd: scope } : {}),
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
  output: ".pi/flow/plan.md",
  ...(scope ? { cwd: scope } : {}),
});

if (!plan.ok) {
  return { ok: false, stage: "plan", error: plan.error || "planner failed" };
}

return {
  ok: true,
  stage: "plan",
  target,
  mapPath: ".pi/flow/map.md",
  planPath: ".pi/flow/plan.md",
  map: scout.output,
  plan: plan.output,
};
