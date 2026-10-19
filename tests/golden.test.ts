// Regression fixtures: real model output that PR Briefings accepted. A schema
// or normalization change that rejects a known-good answer fails here instead
// of in a live run. Add new fixtures from public PRs only (each briefing saves
// its validated output as <head>.json beside the report).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseBriefingDocument } from "../engine/briefing-template";
import { renderBriefingHtml } from "../engine/briefing-render";
import { extractBriefingHtml } from "../engine/briefing-html";
import { buildFacts } from "../engine/facts";
import { buildGenuiBundle } from "../engine/briefing-genui";
import { PullRequest } from "../contract";

const directory = join(import.meta.dirname, "fixtures");
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".briefing.json"));

test("has at least one golden fixture", () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

describe.each(fixtures)("%s", (name) => {
  const saved = JSON.parse(readFileSync(join(directory, name), "utf8"));

  test("still validates, unchanged by normalization", () => {
    const document = parseBriefingDocument(JSON.stringify(saved.document));
    expect(document).toEqual(saved.document);
  });

  test("still renders a safe report and a chat bundle", () => {
    const pr = PullRequest.parse(saved.pr);
    const document = parseBriefingDocument(JSON.stringify(saved.document));
    const facts = buildFacts({ pr, document, diff: "" });
    const html = extractBriefingHtml(renderBriefingHtml({ pr, generationId: saved.generationId, model: saved.model, document, facts }));
    expect(html).toContain(`PR #${pr.number}`);
    for (const item of document.summary) expect(html).toContain(item.claim.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
    if (document.impacts.some((item) => item.dependsOn?.length)) expect(html).toContain('aria-label="Impact graph"');
    const bundle = buildGenuiBundle({ pr, generationId: saved.generationId, model: saved.model, facts, name: `${"c".repeat(24)}-${pr.headSha.slice(0, 12)}` });
    const data = JSON.parse(String(bundle.files.find((file) => file.path === "briefing.json")!.data));
    expect(data.summary).toHaveLength(document.summary.length);
    expect(data.findings).toHaveLength(document.considerations.length);
  });
});
