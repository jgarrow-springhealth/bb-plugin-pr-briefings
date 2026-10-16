import { expect, test } from "vitest";
import {
  acceptanceRows,
  areaBreakdown,
  buildFacts,
  keyHunk,
  normalizeCheckRuns,
  parseUnifiedDiff,
  resolveDocument,
  resolveEvidence,
  visualPairs,
  type Side,
} from "../engine/facts";
import type { BriefingDocument } from "../engine/briefing-template";
import type { PullRequest } from "../contract";

const pr = {
  key: "github.com/example/project#12",
  url: "https://github.com/example/project/pull/12",
  host: "github.com",
  owner: "example",
  repo: "project",
  number: 12,
  title: "Structured profile content",
  author: "dev",
  baseBranch: "main",
  baseSha: "a".repeat(40),
  headBranch: "feature",
  headSha: "b".repeat(40),
  updatedAt: null,
  draft: false,
  requestKinds: [],
  changedFiles: 3,
  additions: 21,
  deletions: 8,
} satisfies PullRequest;

const diff = `diff --git a/src/view.ts b/src/view.ts
index 1111111..2222222 100644
--- a/src/view.ts
+++ b/src/view.ts
@@ -1,3 +1,3 @@ export function view() {
 const a = 1;
-const b = legacy();
+const b = structured();
 return b;
diff --git a/assets/logo.svg b/assets/logo.svg
index 3333333..4444444 100644
--- a/assets/logo.svg
+++ b/assets/logo.svg
@@ -1 +1 @@
-<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>
+<svg viewBox="0 0 2 2"><rect width="2" height="2"/></svg>
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
diff --git a/tests/view.test.ts b/tests/view.test.ts
deleted file mode 100644
index 6666666..0000000
--- a/tests/view.test.ts
+++ /dev/null
@@ -1 +0,0 @@
-test("old", () => {});
diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
diff --git a/img.png b/img.png
index 7777777..8888888 100644
Binary files a/img.png and b/img.png differ
`;

const files: Record<string, string> = {
  "head:src/view.ts": "const a = 1;\nconst b = structured();\nreturn b;\n",
  "base:src/view.ts": "const a = 1;\nconst b = legacy();\nreturn b;\n",
  "head:assets/logo.svg": '<svg viewBox="0 0 2 2"><rect width="2" height="2"/></svg>',
  "base:assets/logo.svg": '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
};
const sources = {
  read: (side: Side, path: string) => files[`${side}:${path}`] ?? null,
  readBytes: (side: Side, path: string) => {
    const text = files[`${side}:${path}`];
    return text === undefined ? null : Buffer.from(text);
  },
};

test("parses statuses, counts, renames, and binaries from a unified diff", () => {
  const parsed = parseUnifiedDiff(diff);
  expect(parsed.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
    ["src/view.ts", "modified", 1, 1],
    ["assets/logo.svg", "modified", 1, 1],
    ["src/new.ts", "added", 2, 0],
    ["tests/view.test.ts", "deleted", 0, 1],
    ["new/name.ts", "renamed", 0, 0],
    ["img.png", "modified", 0, 0],
  ]);
  expect(parsed[4]!.oldPath).toBe("old/name.ts");
  expect(parsed[5]!.binary).toBe(true);
  expect(parsed[0]!.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
  expect(parsed[0]!.hunks[0]!.lines).toHaveLength(4);
});

test("groups changed lines into bounded areas with tests and docs separate", () => {
  const areas = areaBreakdown(parseUnifiedDiff(diff));
  expect(areas.labels).toContain("Tests");
  expect(areas.labels).toContain("src/");
  expect(areas.labels.at(-1)).toBe("Tests");
  const many = parseUnifiedDiff(
    Array.from({ length: 20 }, (_, i) => `diff --git a/d${i}/f.ts b/d${i}/f.ts\n--- a/d${i}/f.ts\n+++ b/d${i}/f.ts\n@@ -1 +1 @@\n-a\n+b\n`).join(""),
  );
  const bounded = areaBreakdown(many, 8);
  expect(bounded.labels).toHaveLength(8);
  expect(bounded.labels.at(-1)).toBe("Other");
  expect(bounded.added.reduce((a, b) => a + b, 0)).toBe(20);
});

test("re-anchors a quoted citation and links it to the commit it describes", () => {
  const moved = resolveEvidence(pr, { path: "src/view.ts", line: 3, quote: "structured()", note: "new" }, "head", sources);
  expect(moved).toMatchObject({ status: "resolved", side: "head", line: 2, citedLine: 3 });
  expect(moved.url).toBe(`https://github.com/example/project/blob/${pr.headSha}/src/view.ts#L2`);

  const before = resolveEvidence(pr, { path: "src/view.ts", line: 2, quote: "legacy()", note: "old" }, "base", sources);
  expect(before).toMatchObject({ status: "resolved", side: "base", line: 2, citedLine: null });
  expect(before.url).toContain(`/blob/${pr.baseSha}/`);

  // Removed code cited as head evidence moves to base, where it exists.
  expect(resolveEvidence(pr, { path: "src/view.ts", line: 2, quote: "legacy()", note: "x" }, "head", sources)).toMatchObject({ side: "base", status: "resolved" });
  expect(resolveEvidence(pr, { path: "src/view.ts", line: 2, quote: "nowhere()", note: "x" }, "head", sources)).toMatchObject({ status: "unresolved", line: 2 });
  expect(resolveEvidence(pr, { path: "src/view.ts", line: 2, note: "x" }, "head", sources)).toMatchObject({ status: "unverified", side: "head" });
  expect(resolveEvidence(pr, { path: "src/view.ts", line: 99, note: "x" }, "head", sources)).toMatchObject({ status: "unresolved" });
  expect(resolveEvidence(pr, { path: "missing.ts", line: 1, note: "x" }, "head", sources)).toMatchObject({ status: "unresolved" });
  expect(resolveEvidence(pr, { path: "src/view.ts", line: 2, quote: "structured()", note: "x" }, "head", null)).toMatchObject({ status: "unverified" });
});

test("maps GitHub check runs to gh pr checks buckets and drops unsafe links", () => {
  const checks = normalizeCheckRuns({
    check_runs: [
      { name: "unit", status: "completed", conclusion: "success", html_url: "https://github.com/x", app: { name: "GitHub Actions" } },
      { name: "lint", status: "completed", conclusion: "failure", html_url: "javascript:alert(1)" },
      { name: "e2e", status: "in_progress", conclusion: null },
      { name: "docs", status: "completed", conclusion: "skipped" },
    ],
  });
  expect(checks.map((check) => [check.name, check.bucket, check.state])).toEqual([
    ["unit", "pass", "SUCCESS"],
    ["lint", "fail", "FAILURE"],
    ["e2e", "pending", "IN_PROGRESS"],
    ["docs", "skipping", "SKIPPED"],
  ]);
  expect(checks[1]!.link).toBeNull();
  expect(normalizeCheckRuns({ nope: true })).toEqual([]);
});

test("pairs changed images and replaced static inline SVG, never templated markup", () => {
  const parsed = parseUnifiedDiff(diff);
  const pairs = visualPairs(parsed, sources);
  expect(pairs).toHaveLength(1);
  expect(pairs[0]).toMatchObject({ path: "assets/logo.svg", identical: false });
  expect(pairs[0]!.before!.bytes.toString()).toContain('viewBox="0 0 1 1"');

  const inline = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-const a = '<svg viewBox="0 0 16 16"><path d="M1 1"/></svg>';
-const b = <svg className={x}><path d="M1 1"/></svg>;
+const a = '<svg viewBox="0 0 16 16"><path d="M2 2"/></svg>';
+const b = <svg className={y}><path d="M2 2"/></svg>;
`);
  // Only the static position pairs; the templated JSX position is skipped.
  expect(visualPairs(inline, sources).map((p) => p.label)).toEqual(["src/a.ts · inline SVG near line 1"]);
  const statics = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const a = '<svg viewBox="0 0 16 16"><path d="M1 1"/></svg>';
+const a = '<svg viewBox="0 0 16 16"><path d="M2 2"/></svg>';
`);
  const pair = visualPairs(statics, sources)[0]!;
  expect(pair.after!.bytes.toString()).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(visualPairs(parsed, sources, 8, 10)).toHaveLength(0);
});

test("prefers a cited, non-test hunk with both additions and removals", () => {
  const hunk = keyHunk(parseUnifiedDiff(diff), ["src/view.ts"]);
  expect(hunk?.path).toBe("src/view.ts");
  expect(hunk?.patch.split("\n").slice(0, 3)).toEqual(["--- a/src/view.ts", "+++ b/src/view.ts", "@@ -1,3 +1,3 @@ export function view() {"]);
});

const document: BriefingDocument = {
  verdict: "Structured content renders first.",
  summary: [
    { kind: "behavior", claim: "One", evidence: [{ path: "src/view.ts", line: 2, quote: "structured()", note: "n" }] },
    { kind: "surface", claim: "Two", evidence: [{ path: "src/view.ts", line: 2, note: "n" }] },
    { kind: "scope", claim: "Three", evidence: [{ path: "src/view.ts", line: 2, quote: "gone()", note: "n" }] },
  ],
  behavior: {
    before: "Legacy.",
    beforeEvidence: [{ path: "src/view.ts", line: 2, quote: "legacy()", note: "old" }],
    after: "Structured.",
    afterEvidence: [{ path: "src/view.ts", line: 2, quote: "structured()", note: "new" }],
  },
  impacts: [{ name: "Profile", kind: "product surface", changed: true, change: "Shows structure", evidence: [] }],
  flows: [],
  boundaries: { inScope: ["Rendering"], outOfScope: ["Editing"], unchanged: ["Fallback", "Routing"] },
  considerations: [],
};

test("reports verified, failed, claimed, and untested rows honestly", () => {
  const resolved = resolveDocument(pr, document, sources);
  expect(resolved.behavior.beforeEvidence[0]).toMatchObject({ side: "base", status: "resolved" });
  const rows = acceptanceRows({
    document: resolved,
    checks: normalizeCheckRuns({ check_runs: [{ name: "unit", status: "completed", conclusion: "success" }, { name: "e2e", status: "queued" }] }),
    visuals: visualPairs(parseUnifiedDiff(diff), sources),
  });
  expect(rows.map((row) => [row.name, row.status])).toEqual([
    ["Quoted citations match the code", "failed"],
    ["1 citation without a quote", "claimed"],
    ["CI passes on the briefed head", "untested"],
    ["Visual changes are intended", "untested"],
    ["Fallback", "claimed"],
    ["Routing", "claimed"],
  ]);
  expect(rows[0]!.note).toBe("2 of 3 quoted citations found in the cited commit; 1 not found.");
  expect(acceptanceRows({ document: resolved, checks: null, visuals: [] })[2]).toMatchObject({ status: "untested", note: "Check runs could not be read." });
});

test("builds every fact without sources as unverified rather than missing", () => {
  const facts = buildFacts({ pr, document, diff: "" });
  expect(facts.document.summary[0]!.evidence[0]!.status).toBe("unverified");
  expect(facts.acceptance[0]).toMatchObject({ status: "untested" });
  expect(facts.files).toEqual([]);
  expect(facts.checks).toBeNull();
});
