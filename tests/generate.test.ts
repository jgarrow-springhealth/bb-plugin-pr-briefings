import { expect, test } from "vitest";
import {
  briefingPrompt,
  parsePullRequestUrl,
  repositoryCloneUrl,
} from "../engine/generate";
import {
  parseBriefingDocument,
  renderBriefingHtml,
} from "../engine/briefing-template";
import type { PullRequest } from "../contract";

const document = {
  verdict:
    "The request changes profile rendering while preserving fallback behavior.",
  summary: [
    {
      kind: "behavior" as const,
      claim: "Structured content is rendered.",
      evidence: [{ path: "src/view.ts", line: 10, note: "Rendering branch" }],
    },
    {
      kind: "surface" as const,
      claim: "The profile is affected.",
      evidence: [{ path: "src/profile.ts", line: 20, note: "Profile entry" }],
    },
    {
      kind: "scope" as const,
      claim: "Legacy fallback remains.",
      evidence: [{ path: "src/fallback.ts", line: 30, note: "Fallback path" }],
    },
  ],
  behavior: {
    before: "Only legacy content rendered.",
    beforeEvidence: [{ path: "src/fallback.ts", line: 30, note: "Old path" }],
    after: "Structured content renders first.",
    afterEvidence: [{ path: "src/view.ts", line: 10, note: "New path" }],
  },
  impacts: [
    {
      name: "Profile",
      kind: "product surface" as const,
      changed: true,
      change: "Structured content appears.",
      evidence: [],
    },
  ],
  flows: [],
  boundaries: {
    inScope: ["Profile rendering"],
    outOfScope: ["Profile editing"],
    unchanged: ["Legacy fallback"],
  },
  considerations: [],
};

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

test("accepts only canonical pull-request URLs", () => {
  expect(parsePullRequestUrl(pr.url)).toMatchObject({
    owner: "example",
    repo: "project",
    number: 12,
  });
  expect(() => parsePullRequestUrl(`${pr.url}?diff=split`)).toThrow();
  expect(() =>
    parsePullRequestUrl("https://evil.example/project/pull/12"),
  ).toThrow();
});

test("clones from the configured GitHub hostname", () => {
  expect(
    repositoryCloneUrl({
      host: "github.example.com",
      owner: "example",
      repo: "project",
    }),
  ).toBe("https://github.example.com/example/project.git");
});

test("normalizes presentation-only evidence overflow", () => {
  const oversized: any = structuredClone(document);
  oversized.summary[0]!.evidence = Array.from({ length: 5 }, (_, index) => ({
    path: `src/summary-${index}.ts`,
    line: index + 1,
    note: `Summary evidence ${index + 1}`,
  }));
  oversized.behavior.afterEvidence = Array.from({ length: 5 }, (_, index) => ({
    path: `src/after-${index}.ts`,
    line: index + 1,
    note: `After evidence ${index + 1}`,
  }));
  oversized.impacts[0]!.evidence = Array.from({ length: 9 }, (_, index) => ({
    path: `src/impact-${index}.ts`,
    line: index + 1,
    note: `Impact evidence ${index + 1}`,
  }));
  const parsed = parseBriefingDocument(JSON.stringify(oversized));
  expect(parsed.summary[0]!.evidence).toHaveLength(4);
  expect(parsed.behavior.afterEvidence).toHaveLength(4);
  expect(parsed.behavior.afterEvidence.at(-1)?.path).toBe("src/after-3.ts");
  expect(parsed.impacts[0]!.evidence).toHaveLength(8);
});

test("validates discarded evidence before applying the presentation bound", () => {
  const unsafe = structuredClone(document);
  unsafe.behavior.afterEvidence = [
    ...Array.from({ length: 4 }, (_, index) => ({
      path: `src/after-${index}.ts`,
      line: index + 1,
      note: `After evidence ${index + 1}`,
    })),
    { path: "../secret", line: 1, note: "Unsafe evidence" },
  ];
  expect(() => parseBriefingDocument(JSON.stringify(unsafe))).toThrow(
    "Evidence path must be repository-relative",
  );
});

test("tells the model about every evidence cardinality bound", () => {
  const prompt = briefingPrompt(pr, "generation-1", "diff --git a/a b/a");
  expect(prompt).toMatch(
    /no more\s+than 4 evidence entries for each summary claim/,
  );
  expect(prompt).toMatch(
    /no more than 4 for each side of\s+the behavior comparison/,
  );
  expect(prompt).toContain("no more than 8 for each impact or consideration");
});

test("renders a standalone PR briefing without Pair Review branding", () => {
  expect(parseBriefingDocument(JSON.stringify(document))).toEqual(document);
  const html = renderBriefingHtml({
    pr,
    generationId: "generation-1",
    model: "openai/gpt-5",
    document,
  });
  expect(html).toContain('<dt>Generation</dt><dd class="mono">generati</dd>');
  expect(html).not.toContain("Pair Review");
});

test("asks the model for quotes and impact edges", () => {
  const prompt = briefingPrompt(pr, "generation-1", "diff --git a/a b/a");
  expect(prompt).toContain('"quote":"exact text from that line"');
  expect(prompt).toMatch(/"dependsOn":\["other-slug"\]/);
  expect(prompt).toMatch(/Before-evidence describes the base commit/);
});

test("accepts quote and graph fields and rejects unsafe impact ids", () => {
  const withGraph = structuredClone(document) as any;
  withGraph.impacts = [
    { ...withGraph.impacts[0], id: "profile", dependsOn: [] },
    { id: "page", dependsOn: ["profile"], name: "Page", kind: "service", changed: false, change: "Uses it", evidence: [{ path: "src/page.ts", line: 3, quote: "profile()", note: "call" }] },
  ];
  expect(parseBriefingDocument(JSON.stringify(withGraph)).impacts[1]).toMatchObject({ id: "page", dependsOn: ["profile"] });
  withGraph.impacts[1].id = 'x"]; click';
  expect(() => parseBriefingDocument(JSON.stringify(withGraph))).toThrow();
});

test("renders verification, charts, graph, visuals, and base-linked evidence as a safe static report", async () => {
  const { buildFacts } = await import("../engine/facts");
  const { extractBriefingHtml } = await import("../engine/briefing-html");
  const graphDocument = {
    ...document,
    behavior: {
      ...document.behavior,
      beforeEvidence: [{ path: "src/fallback.ts", line: 1, quote: "legacy()", note: "Old path" }],
    },
    impacts: [
      { ...document.impacts[0]!, id: "profile" },
      { id: "page", dependsOn: ["profile"], name: "Page", kind: "service" as const, changed: false, change: "Uses it", evidence: [] },
    ],
    considerations: [{ level: "risk" as const, title: "Ordering", detail: "Load first.", evidence: [] }],
  };
  const files: Record<string, string> = {
    "base:src/fallback.ts": "x\nconst y = legacy();\n",
    "base:logo.svg": '<svg viewBox="0 0 1 1"/>',
    "head:logo.svg": '<svg viewBox="0 0 2 2"/>',
  };
  const read = (side: string, path: string) => files[`${side}:${path}`] ?? null;
  const facts = buildFacts({
    pr,
    document: graphDocument,
    diff: "diff --git a/logo.svg b/logo.svg\n--- a/logo.svg\n+++ b/logo.svg\n@@ -1 +1 @@\n-<svg viewBox=\"0 0 1 1\"/>\n+<svg viewBox=\"0 0 2 2\"/>\n",
    sources: { read, readBytes: (side, path) => (read(side, path) === null ? null : Buffer.from(read(side, path)!)) },
    checks: [{ name: "unit", state: "SUCCESS", bucket: "pass", link: "https://github.com/x", workflow: null, startedAt: null, completedAt: null }],
  });
  const html = extractBriefingHtml(
    renderBriefingHtml({ pr, generationId: "generation-1", model: "openai/gpt-5", document: graphDocument, facts }),
  );
  expect(html).toContain(`/blob/${"a".repeat(40)}/src/fallback.ts#L2`);
  expect(html).toContain("model cited line 1");
  expect(html).toContain("Checked automatically");
  expect(html).toContain("Claims to confirm while you review");
  expect(html).toContain('id="impact-1-open" checked');
  expect(html).toContain('aria-label="Lines added and removed by area"');
  expect(html).toContain('aria-label="Impact graph"');
  expect(html).toContain('src="data:image/svg+xml;base64,');
  expect(html).toContain("<span>CI</span><b>1/1</b><span>checks passing</span>");
  // Same card layout and tab order as the Generative UI view, with CSS-only tabs.
  expect([...html.matchAll(/<label for="tab-\d">([^<]+)<\/label>/g)].map((m) => m[1])).toEqual([
    "Overview",
    "Before / after",
    "Impact &amp; flow",
    "Verified",
    "Risks",
    "Evidence",
  ]);
  expect(html).toContain('<input class="tab-input" type="radio" name="tabs" id="tab-1" checked>');
  expect(html).toContain("Remember this");
  expect(html).not.toMatch(/<script/i);
});

test("keeps only the first changed impact and flow step instead of failing", () => {
  const many = structuredClone(document) as any;
  many.impacts = [
    { ...many.impacts[0], name: "A" },
    { ...many.impacts[0], name: "B" },
  ];
  many.flows = [{ title: "F", steps: [{ label: "1", detail: "d", changed: true }, { label: "2", detail: "d", changed: true }] }];
  const parsed = parseBriefingDocument(JSON.stringify(many));
  expect(parsed.impacts.map((item) => item.changed)).toEqual([true, false]);
  expect(parsed.flows[0]!.steps.map((step) => step.changed)).toEqual([true, false]);
});

test("rejects event handlers in markup but not in escaped code text", async () => {
  const { extractBriefingHtml } = await import("../engine/briefing-html");
  const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;
  expect(() => extractBriefingHtml(page('<div onclick="x()">a</div>'))).toThrow("event handlers");
  expect(() => extractBriefingHtml(page('<a href="javascript:alert(1)">a</a>'))).toThrow("event handlers");
  expect(extractBriefingHtml(page('<pre>&lt;button onclick=&quot;close()&quot;&gt;</pre>'))).toContain("onclick=");
});

test("draws dependency chains instead of redundant direct edges", async () => {
  const { impactGraph } = await import("../engine/briefing-render");
  const graph = impactGraph([
    { id: "core", name: "Core", kind: "package", changed: true },
    { id: "pages", dependsOn: ["core"], name: "Pages", kind: "product surface", changed: false },
    { id: "panel", dependsOn: ["core", "pages"], name: "Panel", kind: "product surface", changed: false },
  ]);
  expect(graph?.edges).toEqual([
    { from: "core", to: "pages" },
    { from: "pages", to: "panel" },
  ]);
});

test("asks once for corrected JSON with bounded validation errors", async () => {
  const { repairRequest } = await import("../engine/generate");
  const request = repairRequest(`impacts.1.changed: expected boolean ${"x".repeat(9000)}`);
  expect(request).toContain("impacts.1.changed: expected boolean");
  expect(request).toContain("return the complete corrected JSON object only");
  expect(request.length).toBeLessThan(4300);
});

test("lists risks as filterable rows with how-to-check details", () => {
  const withRisks = {
    ...document,
    considerations: [
      { level: "risk" as const, title: "Breaks ordering", detail: "Load first.", check: "Open pr.html.", evidence: [] },
      { level: "note" as const, title: "Naming", detail: "Minor.", evidence: [] },
    ],
  };
  const html = renderBriefingHtml({ pr, generationId: "g", model: "m", document: withRisks });
  expect(html).toContain('id="rf-risk"');
  expect(html).toContain('id="rf-note"');
  expect(html).not.toContain('id="rf-watch"');
  expect(html).toContain("<b>How to check:</b> Open pr.html.");
  expect(html).toContain('class="xrow rrow sev-row-risk" id="risk-1"');
});

test("fills impacts that omit changed/change instead of failing", () => {
  const partial = structuredClone(document) as any;
  partial.impacts = [
    partial.impacts[0],
    { id: "page", name: "Page", kind: "service", description: "Uses the new view", evidence: [] },
    { id: "tests", name: "Tests", kind: "team", relation: "covers the view", evidence: [] },
  ];
  const parsed = parseBriefingDocument(JSON.stringify(partial));
  expect(parsed.impacts.map((item) => [item.changed, item.change])).toEqual([
    [true, "Structured content appears."],
    [false, "Uses the new view"],
    [false, "covers the view"],
  ]);
  expect("description" in parsed.impacts[1]!).toBe(false);
});
