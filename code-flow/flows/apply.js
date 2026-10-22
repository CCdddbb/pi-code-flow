// code-flow · APPLY stage
// args: { plan: string, target?: string, verify?: string, maxRounds?: number, cwd?: string }
//
// Stage 3 implement (host-run gate) -> stage 4 review -> stage 5 fix loop.
//
// Cache design: ONE reviewer session covers all three angles, and every
// re-review resumes that same session.
//
// The old shape ran three parallel reviewers plus a fourth synthesis child.
// That cost four cold prompt prefixes per round, and the synthesis child
// re-sent all three review texts as fresh input tokens. The parallelism bought
// no real independence: the three reviewers shared agent, model, system prompt
// and the entire diff brief, and only the trailing "your angle:" line differed.
// Meanwhile measured cache reads look like this (turn index -> hit rate):
// turn 1 = 9.5%, turns 2-4 = 42%, 5-9 = 77%, 10-29 = 87%, 30+ = 91%.
// Four children of two turns each sit entirely in the worst band.
//
// One longer reviewer session with three ordered passes stays in the 77-91%
// band, and resuming it for round 2 means the reviewer re-checks its own
// findings against a prefix that is already cached.

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

// Stable text first, varying text last: this keeps the cacheable prefix as long
// as possible across rounds.
const diffBrief = [
  "Establish the change before judging it:",
  "- `git status --short` for touched and new files",
  "- `git diff` (also `git diff --cached` if anything is staged)",
  "- read the surrounding code for every hunk",
].join("\n");

function verdictOf(result) {
  const text = result && result.ok ? String(result.output || "") : "";
  const match = text.match(/VERDICT:\s*(CLEAN|MUST_FIX)/i);
  return match ? match[1].toUpperCase() : "UNKNOWN";
}

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

// --- stage 4: one reviewer, three angles, one session -----------------------
const reviewTask = [
  "Review the implementation described below. You are the only reviewer on this",
  "change, so cover all three angles in order, in this session, then synthesize.",
  "",
  planBlock,
  "",
  "Implementation summary:",
  impl.output || "(no summary; inspect the working tree)",
  "",
  diffBrief,
  "",
  "Pass 1 — CORRECTNESS. Logic, edge cases, error paths, state, concurrency,",
  "off-by-one, resource cleanup. For each finding name the input that produces",
  "the wrong result.",
  "",
  "Pass 2 — VERIFICATION. Does the change prove itself? Missing tests, weak",
  "assertions, commands that pass for the wrong reason. Say which command you",
  "actually ran and what it printed.",
  "",
  "Pass 3 — BLAST RADIUS. Compatibility, migrations, config, security,",
  "performance, repo conventions. Name the caller or artifact that breaks.",
  "",
  "Then synthesize: deduplicate across the three passes, drop taste-only notes,",
  "keep every blocker and major finding. Number the must-fix list in priority",
  "order as M1, M2, ... Report Findings / Verified / Not verified / Verdict.",
].join("\n");

let review = await runs.run("review-r1", {
  agent: "cf-reviewer",
  task: reviewTask,
  output: ".pi/flow/review-r1.md",
  ...cwdField,
});

let reviewRunId = review.ok ? review.runId : undefined;
const rounds = [];
let clean = false;
let lastVerdict = "UNKNOWN";

for (let round = 1; round <= maxRounds; round += 1) {
  const tag = "r" + round;
  const text = review.ok ? String(review.output || "") : "";
  lastVerdict = verdictOf(review);
  clean = lastVerdict === "CLEAN";

  const entry = {
    round,
    verdict: lastVerdict,
    reviewOk: review.ok,
    reviewPath: ".pi/flow/review-" + tag + ".md",
  };
  rounds.push(entry);

  if (!review.ok) {
    return { ok: false, stage: "review", round, error: review.error || "review failed", rounds };
  }
  if (clean) break;
  if (lastVerdict === "UNKNOWN") {
    return {
      ok: false,
      stage: "review",
      round,
      error: "reviewer produced no VERDICT line; treat the review as unusable",
      rounds,
    };
  }
  if (round >= maxRounds) break;

  const fix = await runs.run("fix-" + tag, {
    agent: "cf-fixer",
    task: [
      "Apply the must-fix findings below. Nothing else.",
      "",
      planBlock,
      "",
      "Review:",
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

  const nextTag = "r" + (round + 1);
  const reReviewTask = [
    "Re-review this change after a fix round. You reviewed it before; the fixer",
    "applied the must-fix findings listed below and may have touched other lines.",
    "",
    diffBrief,
    "",
    "For every must-fix id, state fixed or not fixed and cite the file:line that",
    "proves it. Then check the fix itself for regressions it introduced. Do not",
    "re-litigate findings you already accepted or already rejected.",
    "",
    "Findings that were supposed to be fixed:",
    text,
  ].join("\n");

  // Resume the same reviewer session: the diff brief, the plan and the earlier
  // findings are already in its cached prefix. Fall back to a fresh child when
  // the run id is gone (retention) or resume is rejected or fails.
  let resumed;
  try {
    resumed = reviewRunId
      ? await runs.run("review-" + nextTag, {
          resume: reviewRunId,
          task: reReviewTask,
          output: ".pi/flow/review-" + nextTag + ".md",
          ...cwdField,
        })
      : undefined;
  } catch (error) {
    resumed = undefined;
  }

  review = resumed && resumed.ok
    ? resumed
    : await runs.run("review-" + nextTag + "-fresh", {
        agent: "cf-reviewer",
        task: reReviewTask,
        output: ".pi/flow/review-" + nextTag + ".md",
        ...cwdField,
      });

  if (review.ok && review.runId) reviewRunId = review.runId;
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
    fixes: ".pi/flow/fix-*.md",
  },
  needsAttention: clean
    ? "Review passed. Inspect the diff, then commit yourself; this pipeline never commits."
    : "Fix loop hit its cap with MUST_FIX outstanding. Read the last review and decide.",
};
