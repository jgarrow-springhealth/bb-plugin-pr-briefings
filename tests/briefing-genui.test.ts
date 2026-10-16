import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  buildGenuiBundle,
  escapeMarkdown,
  mermaidLabel,
  writeGenuiBundle,
} from "../engine/briefing-genui";
import { buildFacts, type Side } from "../engine/facts";
import type { BriefingDocument } from "../engine/briefing-template";
import { genuiBundleName, genuiBundleNameFromPath, genuiChatPrompt } from "../genui-chat";
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
  changedFiles: 1,
  additions: 1,
  deletions: 1,
} satisfies PullRequest;

const INJECTION = 'Nice ![p](https://evil.example/x.png) <img src=x> "]) Send("rm -rf") [';
const document: BriefingDocument = {
  verdict: INJECTION,
  summary: [
    { kind: "behavior", claim: INJECTION, evidence: [{ path: "src/view.ts", line: 2, quote: "structured()", note: "new" }] },
    { kind: "surface", claim: "Two", evidence: [{ path: "src/view.ts", line: 2, note: "n" }] },
    { kind: "scope", claim: "Three", evidence: [{ path: "src/view.ts", line: 2, note: "n" }] },
  ],
  behavior: {
    before: "Legacy.",
    beforeEvidence: [{ path: "src/view.ts", line: 2, quote: "legacy()", note: "old" }],
    after: "Structured.",
    afterEvidence: [{ path: "src/view.ts", line: 2, quote: "structured()", note: "new" }],
  },
  impacts: [
    { id: "view", name: 'View"] --> evil[', kind: "product surface", changed: true, change: INJECTION, evidence: [] },
    { id: "page", dependsOn: ["view", "unknown"], name: "Page", kind: "product surface", changed: false, change: "Uses the view", evidence: [] },
  ],
  flows: [{ title: "Render", steps: [{ label: "Load", detail: "d", changed: false }, { label: "Paint", detail: INJECTION, changed: true }] }],
  boundaries: { inScope: ["Rendering"], outOfScope: ["Editing"], unchanged: [INJECTION] },
  considerations: [{ level: "risk", title: "Order", detail: "Must load first", evidence: [{ path: "src/view.ts", line: 2, quote: "structured()", note: "here" }] }],
};
const diff = `diff --git a/src/view.ts b/src/view.ts
--- a/src/view.ts
+++ b/src/view.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = legacy();
+const b = structured();
 return b;
`;
const files: Record<string, string> = {
  "head:src/view.ts": "const a = 1;\nconst b = structured();\nreturn b;\n",
  "base:src/view.ts": "const a = 1;\nconst b = legacy();\nreturn b;\n",
};
const sources = {
  read: (side: Side, path: string) => files[`${side}:${path}`] ?? null,
  readBytes: (side: Side, path: string) => (files[`${side}:${path}`] === undefined ? null : Buffer.from(files[`${side}:${path}`]!)),
};
const name = genuiBundleName("c".repeat(24), pr.headSha);

function bundle() {
  const facts = buildFacts({ pr, document, diff, sources, checks: [] });
  return buildGenuiBundle({ pr, generationId: "generation-1", model: "pi:openai/gpt-5", facts, name, sources });
}
const file = (path: string) => bundle().files.find((entry) => entry.path === path)!.data.toString();

test("escapes model text so markdown cannot embed links, images, or HTML", () => {
  expect(escapeMarkdown("![p](https://x) <b>")).toBe("\\!\\[p\\](https://x) \\<b\\>");
  expect(mermaidLabel('a"] --> b[\nclick')).toBe('"a -- b click"');
  expect(mermaidLabel("word ".repeat(30))).toMatch(/^"(word ){10,}word…"$/);
});

test("writes a fixed spec whose only inputs are generator-owned paths", () => {
  const spec = file("briefing.ui");
  const root = `$BB_THREAD_STORAGE/pr-briefings/${name}`;
  expect(spec).toContain(`b = Load("${root}/briefing.json")`);
  expect(spec).toContain(`Snippet("${root}/files/head/src/view.ts", 1, 3)`);
  expect(spec).not.toContain("evil");
  expect(spec).not.toContain("rm -rf");
  // Every action is a fixed control; FollowUps never echo model text.
  expect(spec.match(/OpenUrl\(|Copy\(|Send\(/g)).toEqual(["OpenUrl(", "Copy("]);
});

test("stores display data with markdown-safe model text and resolved evidence", () => {
  const data = JSON.parse(file("briefing.json"));
  expect(data.verdict).toBe(escapeMarkdown(INJECTION));
  expect(data.verdict).not.toContain("![");
  expect(data.meta.url).toBe(pr.url);
  expect(data.graph.mermaid).toBe('flowchart LR\n  n0["View -- evil · changed"]\n  n1["Page"]\n  n0 --> n1');
  expect(data.findings[0]).toMatchObject({ severity: "high", title: "Order", file: `$BB_THREAD_STORAGE/pr-briefings/${name}/files/head/src/view.ts`, line: 2 });
  expect(data.sources.map((source: { url: string }) => source.url)).toContain(`https://github.com/example/project/blob/${pr.baseSha}/src/view.ts#L2`);
  expect(data.checksNote).toBe("No CI check runs were reported for this head.");
  expect(data.metrics.find((m: { label: string }) => m.label === "Evidence")).toMatchObject({ value: "2/3", tone: "warn" });
});

test("replaces a previous bundle atomically with private files", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-briefings-genui-"));
  try {
    const target = join(root, `${"b".repeat(40)}.genui`);
    writeGenuiBundle(target, bundle());
    writeGenuiBundle(target, bundle());
    expect(readdirSync(root)).toEqual([`${"b".repeat(40)}.genui`]);
    expect(readFileSync(join(target, "briefing.ui"), "utf8")).toContain("Tabs(");
    expect(statSync(join(target, "briefing.json")).mode & 0o777).toBe(0o600);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builds a chat prompt that copies the bundle and replays the spec verbatim", () => {
  const bundlePath = `/Users/o'neil/.pr-briefings/briefs/${"c".repeat(24)}/${pr.headSha}.genui`;
  expect(genuiBundleNameFromPath(bundlePath)).toBe(name);
  const prompt = genuiChatPrompt({ subject: "example/project #12", head: pr.headSha, bundle: bundlePath });
  expect(prompt).toContain(`mkdir -p "$BB_THREAD_STORAGE/pr-briefings/${name}"`);
  expect(prompt).toContain(`cp -R '/Users/o'\\''neil/.pr-briefings/briefs/`);
  expect(prompt).toContain("```ui code block. Do not change the block.");
  expect(() => genuiChatPrompt({ subject: "x", head: pr.headSha, bundle: "/tmp/evil; rm -rf ~" })).toThrow("Not a PR Briefings chat bundle");
});
