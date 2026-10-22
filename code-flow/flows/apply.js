// code-flow · APPLY stage
// args: { plan: string, target?: string, verify?: string, maxRounds?: number, cwd?: string }
//
// Stage 3 implement (host-run gate) -> stage 4 parallel review -> stage 5 fix loop.
// Every implement/fix child carries the verify command as a host-run gate, so
// "ok" means the command actually passed, not that the child claimed success.

const planText = typeof args.plan === "string" ? args.plan.trim() : "";
if (!planText) {
  return { ok: false, error: "args.plan is required (read .pi/flow/plan.md first)" };
}

const target = typeof args.target === "string" && args.target.trim() ? args.target.trim() : "(see plan)";
const verify = typeof args.verify === "string" && args.verify.trim() ? args.verify.trim() : "";
const maxRounds = Number.isInteger(args.maxRounds) ? Math.min(Math.max(args.maxRounds, 1), 4) : 2;
const scope = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : undefined;
const cwdField = scope ? { cwd: scope } : {};
const gateField = verify ? { gate: verify } : {};

const planBlock = ["Approved plan:", planText].join("\n");

// --- stage 3: implement -----------------------------------------------------
const impl = await runs.run("impl", {
  agent: "worker",
  task: [
    "Implement this approved plan in the current repository.",
    "The plan is the contract: do not expand scope, do not redesign.",
    "If a step is wrong against the real code, implement the correct version and say so in your summary.",
    "",
    planBlock,
  ].join("\n"),
  output: ".pi/flow/impl.md",
  ...gateField,
  ...cwdField,
});

if (!impl.ok) {
  return {
    ok: false,
    stage: "impl",
    error: impl.error || (verify ? `implementation failed gate: ${verify}` : "implementation failed"),
  };
}

// --- stages 4+5: review / fix loop -----------------------------------------
const rounds = [];
let clean = false;
let lastVerdict = "UNKNOWN";

for (let round = 1; round <= maxRounds; round += 1) {
  const tag = "r" + round;
  const diffHint = [
    "Review the implementation described below. Read the real diff and surrounding code.",
    "",
    planBlock,
    "",
    "Implementation summary:",
    impl.output || "(no summary; inspect the working tree)",
  ].join("\n");

  const reviews = await runs.all([
    {
      key: "review-correctness-" + tag,
      agent: "cf-reviewer",
      task:
        diffHint +
        "\n\nYour angle: CORRECTNESS. Logic, edge cases, error paths, state, concurrency, off-by-one.",
      output: ".pi/flow/review-" + tag + "-correctness.md",
      ...cwdField,
    },
    {
      key: "review-tests-" + tag,
      agent: "cf-reviewer",
      task:
        diffHint +
        "\n\nYour angle: VERIFICATION. Does the change prove itself? Missing tests, weak assertions, commands that pass for the wrong reason.",
      output: ".pi/flow/review-" + tag + "-tests.md",
      ...cwdField,
    },
    {
      key: "review-risk-" + tag,
      agent: "cf-reviewer",
      task:
        diffHint +
        "\n\nYour angle: BLAST RADIUS. Compatibility, migrations, config, security, performance, repo conventions.",
      output: ".pi/flow/review-" + tag + "-risk.md",
      ...cwdField,
    },
  ]);

  const reviewText = reviews
    .map((r, i) => "### Review " + (i + 1) + "\n" + (r.ok ? r.output : "(failed: " + (r.error || "unknown") + ")"))
    .join("\n\n");

  const synth = await runs.run("synth-" + tag, {
    agent: "cf-reviewer",
    task: [
      "You are synthesizing three independent reviews of one change.",
      "Merge them: deduplicate, drop taste-only notes, keep every blocker and major finding.",
      "Number the must-fix list in priority order and give each an id (M1, M2, ...).",
      "",
      reviewText,
      "",
      "End with the required VERDICT line.",
    ].join("\n"),
    output: ".pi/flow/synth-" + tag + ".md",
    ...cwdField,
  });

  const text = synth.ok ? String(synth.output || "") : "";
  const match = text.match(/VERDICT:\s*(CLEAN|MUST_FIX)/i);
  lastVerdict = match ? match[1].toUpperCase() : "UNKNOWN";
  clean = lastVerdict === "CLEAN";

  const entry = {
    round,
    verdict: lastVerdict,
    reviewOk: reviews.every(function (r) {
      return r.ok;
    }),
    synthPath: ".pi/flow/synth-" + tag + ".md",
  };
  rounds.push(entry);

  if (clean) break;
  if (!synth.ok) {
    return { ok: false, stage: "review", round, error: synth.error || "synthesis failed", rounds };
  }

  const fix = await runs.run("fix-" + tag, {
    agent: "cf-fixer",
    task: [
      "Apply the must-fix findings below. Nothing else.",
      "",
      planBlock,
      "",
      "Review synthesis:",
      text,
    ].join("\n"),
    output: ".pi/flow/fix-" + tag + ".md",
    ...gateField,
    ...cwdField,
  });

  entry.fixOk = fix.ok;
  entry.fixPath = ".pi/flow/fix-" + tag + ".md";
  if (!fix.ok) {
    return {
      ok: false,
      stage: "fix",
      round,
      error: fix.error || (verify ? `fix failed gate: ${verify}` : "fix failed"),
      rounds,
    };
  }
}

return {
  ok: clean,
  stage: "apply",
  target,
  verify: verify || null,
  clean,
  verdict: lastVerdict,
  rounds,
  artifacts: {
    plan: ".pi/flow/plan.md",
    impl: ".pi/flow/impl.md",
    reviews: ".pi/flow/review-*.md",
    synthesis: ".pi/flow/synth-*.md",
  },
  needsAttention: clean
    ? "Review passed. Inspect the diff, then commit yourself; this pipeline never commits."
    : "Fix loop hit its cap with MUST_FIX outstanding. Read the last synthesis and decide.",
};
