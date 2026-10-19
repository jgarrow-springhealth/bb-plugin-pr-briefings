// End-to-end shape tests: each case is a kind of pull request (or a kind of
// model answer) run through the whole pipeline — validation, facts, the HTML
// report and its safety check, and the Generative UI bundle. A schema rule that
// a legitimate PR can break should fail here, not in a live run.
import { describe, expect, test } from "vitest";
import { parseBriefingDocument } from "../engine/briefing-template";
import { renderBriefingHtml } from "../engine/briefing-render";
import { extractBriefingHtml } from "../engine/briefing-html";
import { buildFacts, type Side } from "../engine/facts";
import { buildGenuiBundle } from "../engine/briefing-genui";
import type { PullRequest } from "../contract";

const pr = {
  key: "github.com/example/project#7",
  url: "https://github.com/example/project/pull/7",
  host: "github.com",
  owner: "example",
  repo: "project",
  number: 7,
  title: "Shape test",
  author: "dev",
  baseBranch: "main",
  baseSha: "a".repeat(40),
  headBranch: "feature",
  headSha: "b".repeat(40),
  updatedAt: null,
  draft: false,
  requestKinds: [],
  changedFiles: 1,
  additions: 1,
  deletions: 0,
} satisfies PullRequest;

type Files = Record<string, string | Buffer>;
function run(options: { diff: string; output: unknown; files?: Files }) {
  const files = options.files ?? {};
  const bytes = (side: Side, path: string) => {
    const value = files[`${side}:${path}`];
    return value === undefined ? null : Buffer.isBuffer(value) ? value : Buffer.from(value);
  };
  const sources = { readBytes: bytes, read: (side: Side, path: string) => bytes(side, path)?.toString("utf8") ?? null };
  const document = parseBriefingDocument(typeof options.output === "string" ? options.output : JSON.stringify(options.output));
  const facts = buildFacts({ pr, document, diff: options.diff, sources, checks: [], screenshots: [] });
  const html = extractBriefingHtml(renderBriefingHtml({ pr, generationId: "generation", model: "test:model", document, facts }));
  const bundle = buildGenuiBundle({ pr, generationId: "generation", model: "test:model", facts, name: `${"c".repeat(24)}-${"b".repeat(12)}`, sources });
  const data = JSON.parse(String(bundle.files.find((file) => file.path === "briefing.json")!.data));
  const spec = String(bundle.files.find((file) => file.path === "briefing.ui")!.data);
  return { document, facts, html, data, spec };
}

/** A minimal valid answer; cases override what their shape changes. */
function answer(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "Adds a seeding task.",
    summary: [
      { kind: "behavior", claim: "A new task seeds tags.", evidence: [{ path: "app/task.rb", line: 2, quote: "def process", note: "Entry point" }] },
      { kind: "scope", claim: "No API changes.", evidence: [] },
      { kind: "compatibility", claim: "Dry run by default.", evidence: [{ path: "app/task.rb", line: 1, quote: "dry_run", note: "Default" }] },
    ],
    behavior: {
      before: "There was no seeding task.",
      beforeEvidence: [],
      after: "A task seeds missing tags.",
      afterEvidence: [{ path: "app/task.rb", line: 2, quote: "def process", note: "New task" }],
    },
    impacts: [{ id: "task", name: "Seeding task", kind: "service", changed: true, change: "New.", evidence: [] }],
    flows: [],
    boundaries: { inScope: ["Seeding"], outOfScope: ["UI"], unchanged: ["Existing tags"] },
    considerations: [],
    ...overrides,
  };
}

const ADD = `diff --git a/app/task.rb b/app/task.rb
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/app/task.rb
@@ -0,0 +1,3 @@
+attribute :dry_run, default: true
+def process
+end
`;

describe("pull-request shapes", () => {
  test("add-only: no before-evidence, examples found in the new file", () => {
    const { document, facts, html, data } = run({
      diff: ADD,
      files: { "head:app/task.rb": "attribute :dry_run, default: true\ndef process\nend\n" },
      output: answer({ behavior: { ...answer().behavior, examples: [{ path: "app/task.rb", quote: "+def process", caption: "The task's entry point" }] } }),
    });
    expect(document.behavior.beforeEvidence).toEqual([]);
    expect(facts.examples).toHaveLength(1);
    expect(facts.document.behavior.afterEvidence[0]).toMatchObject({ status: "resolved", side: "head" });
    expect(html).toContain("Before this PR");
    expect(html).toContain("The task&#39;s entry point");
    expect(data.code).toHaveLength(1);
  });

  test("delete-only: after-evidence may be empty and before resolves to the base commit", () => {
    const diff = `diff --git a/app/old.rb b/app/old.rb
deleted file mode 100644
index 2222222..0000000
--- a/app/old.rb
+++ /dev/null
@@ -1,2 +0,0 @@
-def legacy
-end
`;
    const { facts, html } = run({
      diff,
      files: { "base:app/old.rb": "def legacy\nend\n" },
      output: answer({
        summary: [{ kind: "scope", claim: "Removes the legacy path.", evidence: [{ path: "app/old.rb", line: 1, quote: "def legacy", note: "Removed" }] }],
        behavior: { before: "A legacy path existed.", beforeEvidence: [{ path: "app/old.rb", line: 1, quote: "def legacy", note: "Old" }], after: "It is gone.", afterEvidence: [] },
      }),
    });
    expect(facts.document.behavior.beforeEvidence[0]).toMatchObject({ status: "resolved", side: "base" });
    expect(facts.document.summary[0]!.evidence[0]).toMatchObject({ side: "base", status: "resolved" });
    expect(facts.files[0]).toMatchObject({ status: "deleted", deletions: 2 });
    expect(html).toContain(`/blob/${pr.baseSha}/app/old.rb#L1`);
  });

  test("rename-only: no hunks, no code example, still renders", () => {
    const diff = `diff --git a/lib/a.rb b/lib/b.rb
similarity index 100%
rename from lib/a.rb
rename to lib/b.rb
`;
    const { facts, html, data } = run({
      diff,
      files: { "head:lib/b.rb": "x\n" },
      output: answer({
        summary: [{ kind: "scope", claim: "Renames a file.", evidence: [{ path: "lib/b.rb", note: "New name" }] }],
        behavior: { before: "Named a.rb.", beforeEvidence: [], after: "Named b.rb.", afterEvidence: [{ path: "lib/b.rb", note: "Renamed" }] },
      }),
    });
    expect(facts.files).toEqual([{ path: "lib/b.rb", status: "renamed", additions: 0, deletions: 0 }]);
    expect(facts.keyHunk).toBeNull();
    expect(html).toContain("No code example is available for this PR.");
    expect(data.code).toEqual([]);
  });

  test("docs-only: a Docs area, no flows, no risks", () => {
    const diff = `diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-Old intro
+New intro
`;
    const { facts, html } = run({
      diff,
      files: { "head:README.md": "New intro\n", "base:README.md": "Old intro\n" },
      output: answer({
        summary: [{ kind: "scope", claim: "Updates the README intro.", evidence: [{ path: "README.md", line: 1, quote: "New intro", note: "Intro" }] }],
        behavior: { before: "Old intro.", beforeEvidence: [{ path: "README.md", line: 1, quote: "Old intro", note: "Was" }], after: "New intro.", afterEvidence: [{ path: "README.md", line: 1, quote: "New intro", note: "Now" }] },
        impacts: [{ id: "docs", name: "README", kind: "team", changed: true, change: "Reworded.", evidence: [] }],
      }),
    });
    expect(facts.areas.labels).toEqual(["Docs"]);
    expect(html).toContain("This PR doesn't change how requests or data move through the system.");
    expect(html).toContain("The AI didn't flag any risks or open questions for this PR.");
  });

  test("image/binary-only: before/after images, no code example", () => {
    const png = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed]);
    const diff = `diff --git a/assets/logo.png b/assets/logo.png
index 5555555..6666666 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/assets/icon.svg b/assets/icon.svg
index 7777777..8888888 100644
--- a/assets/icon.svg
+++ b/assets/icon.svg
@@ -1 +1 @@
-<svg viewBox="0 0 1 1"/>
+<svg viewBox="0 0 2 2"/>
`;
    const { facts, html, data } = run({
      diff,
      files: { "base:assets/logo.png": png(1), "head:assets/logo.png": png(2), "base:assets/icon.svg": '<svg viewBox="0 0 1 1"/>', "head:assets/icon.svg": '<svg viewBox="0 0 2 2"/>' },
      output: answer({
        summary: [{ kind: "surface", claim: "Updates the logo and icon.", evidence: [{ path: "assets/logo.png", note: "Logo" }] }],
        behavior: { before: "Old artwork.", beforeEvidence: [], after: "New artwork.", afterEvidence: [{ path: "assets/icon.svg", line: 1, quote: "viewBox", note: "Icon" }] },
      }),
    });
    expect(facts.visuals.map((pair) => [pair.path, pair.identical])).toEqual([
      ["assets/logo.png", false],
      ["assets/icon.svg", false],
    ]);
    expect(html).toContain('src="data:image/png;base64,');
    expect(data.visuals).toHaveLength(2);
  });

  test("one-line typo fix: one summary point, empty boundaries, no 'Remember this'", () => {
    const diff = `diff --git a/app/copy.rb b/app/copy.rb
index 9999999..aaaaaaa 100644
--- a/app/copy.rb
+++ b/app/copy.rb
@@ -1 +1 @@
-TITLE = "Welcom"
+TITLE = "Welcome"
`;
    const { document, html, data } = run({
      diff,
      files: { "head:app/copy.rb": 'TITLE = "Welcome"\n', "base:app/copy.rb": 'TITLE = "Welcom"\n' },
      output: answer({
        summary: [{ kind: "behavior", claim: "Fixes a typo in the title.", evidence: [{ path: "app/copy.rb", line: 1, quote: '"Welcome"', note: "Fixed" }] }],
        behavior: { before: "Title read Welcom.", beforeEvidence: [{ path: "app/copy.rb", line: 1, quote: "Welcom", note: "Typo" }], after: "Title reads Welcome.", afterEvidence: [{ path: "app/copy.rb", line: 1, quote: "Welcome", note: "Fix" }] },
        boundaries: { inScope: ["The title"], outOfScope: [], unchanged: [] },
      }),
    });
    expect(document.summary).toHaveLength(1);
    expect(html).not.toContain("Remember this");
    expect(data.remember).toBeNull();
  });

  test("large PR: many areas collapse into Other and long lists are trimmed", () => {
    const diff = Array.from(
      { length: 20 },
      (_, i) => `diff --git a/pkg${i}/f.ts b/pkg${i}/f.ts\n--- a/pkg${i}/f.ts\n+++ b/pkg${i}/f.ts\n@@ -1 +1 @@\n-a\n+b\n`,
    ).join("");
    const item = (i: number) => ({ id: `part-${i}`, name: `Part ${i}`, kind: "package", changed: i === 0, change: `Changes part ${i}.`, evidence: [] });
    const { document, facts, html } = run({
      diff,
      output: answer({
        verdict: "x".repeat(600),
        summary: Array.from({ length: 8 }, (_, i) => ({ kind: "behavior", claim: `Point ${i}`, evidence: [] })),
        impacts: Array.from({ length: 15 }, (_, i) => item(i)),
        considerations: Array.from({ length: 10 }, (_, i) => ({ level: "note", title: `Risk ${i}`, detail: "d", evidence: [] })),
      }),
    });
    expect(facts.areas.labels).toHaveLength(8);
    expect(facts.areas.labels.at(-1)).toBe("Other");
    expect(document.verdict).toHaveLength(320);
    expect(document.verdict.endsWith("…")).toBe(true);
    expect([document.summary.length, document.impacts.length, document.considerations.length]).toEqual([6, 12, 8]);
    expect(html).toContain("Part 11");
  });
});

describe("model answers that vary but are valid", () => {
  test("extra keys, loose enums, odd ids and lines, empty optionals, uneven flows, prose around the JSON", () => {
    const messy = answer({
      confidence: 0.9,
      summary: [
        { kind: "UI", claim: "Changes the screen.", evidence: [{ path: "app/task.rb", line: "2", quote: "", note: "", extra: true }] },
        { kind: "compat", claim: "Backwards compatible.", evidence: [{ path: "app/task.rb", line: 0, note: "File-level" }] },
        { kind: "risk", claim: "Edge case.", evidence: [{ path: "app/task.rb", line: "1-3", note: "Range" }] },
      ],
      impacts: [
        { id: "Seeding_Task", name: "Seeding task", kind: "backend job", changed: true, change: "New.", relation: "", evidence: [] },
        { id: "Admin UI", dependsOn: ["Seeding_Task", "missing"], name: "Admin", kind: "UI", change: "Shows tags.", evidence: [] },
      ],
      flows: [
        { title: "Too short", steps: [{ label: "Only", detail: "One step", changed: false }] },
        { title: "Long", steps: Array.from({ length: 10 }, (_, i) => ({ label: `Step ${i}`, detail: "d", changed: i === 9 })) },
      ],
      considerations: [
        { level: "High", title: "Ordering", detail: "Run after R4.", check: "", evidence: [] },
        { level: "low", title: "Naming", detail: "Minor.", evidence: [] },
        { level: "unknown", title: "Other", detail: "?", evidence: [] },
      ],
    });
    (messy.behavior as Record<string, unknown>).examples = [{ path: "app/task.rb", quote: "def process" }];
    const output = `Here is the briefing:\n\`\`\`json\n${JSON.stringify(messy, null, 2)}\n\`\`\`\nLet me know if you need more.`;
    const { document, html } = run({ diff: ADD, files: { "head:app/task.rb": "attribute :dry_run, default: true\ndef process\nend\n" }, output });
    expect("confidence" in document).toBe(false);
    expect(document.summary.map((item) => item.kind)).toEqual(["surface", "compatibility", "behavior"]);
    expect(document.summary[0]!.evidence[0]).toEqual({ path: "app/task.rb", line: 2, note: "Cited by the briefing" });
    expect(document.summary[1]!.evidence[0]!.line).toBeUndefined();
    expect(document.summary[2]!.evidence[0]!.line).toBe(1);
    expect(document.impacts.map((item) => [item.id, item.kind, item.changed, item.dependsOn ?? null, item.relation ?? null])).toEqual([
      ["seeding-task", "service", true, null, null],
      ["admin-ui", "product surface", false, ["seeding-task", "missing"], null],
    ]);
    expect(document.flows.map((flow) => [flow.title, flow.steps.length])).toEqual([["Long", 8]]);
    expect(document.considerations.map((item) => [item.level, item.check ?? null])).toEqual([
      ["risk", null],
      ["note", null],
      ["watch", null],
    ]);
    expect(document.behavior.examples).toEqual([]);
    expect(html).toContain("Seeding task");
  });

  test("uncited summary points become claims to confirm on the Verified tab", () => {
    const { facts, html } = run({ diff: ADD, files: { "head:app/task.rb": "def process\n" }, output: answer() });
    expect(facts.acceptance.find((row) => row.name === "No API changes.")).toMatchObject({ status: "claimed", by: "model" });
    expect(html).toContain("No API changes.");
  });
});

describe("answers that must still fail", () => {
  test("an unsafe path is rejected even in an entry trimmed away by the limits", () => {
    const impacts = Array.from({ length: 13 }, (_, i) => ({ name: `Part ${i}`, kind: "package", changed: false, change: "c", evidence: i === 12 ? [{ path: "../secret", note: "x" }] : [] }));
    expect(() => run({ diff: ADD, output: answer({ impacts }) })).toThrow("Evidence path must be repository-relative");
  });

  test("absolute paths and control characters are rejected", () => {
    expect(() => run({ diff: ADD, output: answer({ summary: [{ kind: "behavior", claim: "x", evidence: [{ path: "/etc/passwd", note: "x" }] }] }) })).toThrow("repository-relative");
    expect(() => run({ diff: ADD, output: answer({ verdict: "bad\u0007bell" }) })).toThrow("control characters");
  });

  test("a comparison that cites nothing at all is rejected", () => {
    expect(() => run({ diff: ADD, output: answer({ behavior: { before: "b", beforeEvidence: [], after: "a", afterEvidence: [] } }) })).toThrow(
      "must cite evidence for before or after",
    );
  });

  test("non-JSON output is rejected", () => {
    expect(() => run({ diff: ADD, output: "I could not produce a briefing." })).toThrow("did not return a JSON object");
  });
});
