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
  expect(html).toContain("Generation</dt><dd><code>generation-1</code>");
  expect(html).not.toContain("Pair Review");
});
