// Deterministic briefing facts: everything here is derived from the exact PR
// diff, the base and head file contents, and GitHub check runs. No model
// output is trusted to produce these values; model-authored evidence is only
// *checked* here (resolved against the real files), never believed.
import type { PullRequest } from "../contract.ts";
import type { BriefingDocument, EvidenceItem } from "./briefing-template.ts";

export type Side = "base" | "head";

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: string[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

const unquote = (value: string) =>
  value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/\\(.)/g, "$1")
    : value;

/** Parses a git unified diff (as returned by the GitHub compare API). */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      file = {
        path: unquote(match?.[2] ?? ""),
        oldPath: unquote(match?.[1] ?? ""),
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      hunk = null;
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = unquote(line.slice("rename from ".length));
      } else if (line.startsWith("rename to "))
        file.path = unquote(line.slice("rename to ".length));
      else if (line.startsWith("Binary files ")) file.binary = true;
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null")
        file.path = unquote(line.slice(4).replace(/^b\//, ""));
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      hunk = {
        header: line,
        oldStart: Number(header[1]),
        newStart: Number(header[2]),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) file.additions++;
    else if (line.startsWith("-")) file.deletions++;
    if (/^[ +\-\\]/.test(line) || line === "") hunk.lines.push(line);
  }
  for (const entry of files) {
    if (entry.status !== "renamed") entry.oldPath = null;
    // Trailing empty context lines come from the split, not the diff.
    for (const h of entry.hunks)
      while (h.lines.length && h.lines.at(-1) === "") h.lines.pop();
  }
  return files.filter((entry) => entry.path);
}

export interface AreaBreakdown {
  labels: string[];
  added: number[];
  removed: number[];
  files: number[];
}

const TEST_PATH = /(^|\/)(__tests__|tests?|spec|e2e)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i;
const DOC_PATH = /(^|\/)(docs?|\.changeset|plans?)(\/|$)|\.(md|mdx|rst|txt)$/i;

/**
 * Groups changed lines into at most `limit` areas: tests and docs get their
 * own bucket, everything else is grouped by directory at the deepest level
 * that still yields `limit` groups or fewer.
 */
export function areaBreakdown(files: DiffFile[], limit = 8): AreaBreakdown {
  const special = (path: string) =>
    TEST_PATH.test(path) ? "Tests" : DOC_PATH.test(path) ? "Docs" : null;
  const rest = files.filter((file) => !special(file.path));
  const group = (path: string, depth: number) => {
    const parts = path.split("/").slice(0, -1);
    return parts.length ? parts.slice(0, depth).join("/") + "/" : "(root)";
  };
  let depth = 4;
  while (
    depth > 1 &&
    new Set(rest.map((file) => group(file.path, depth))).size > limit - 2
  )
    depth--;
  const totals = new Map<string, { added: number; removed: number; files: number }>();
  for (const file of files) {
    const key = special(file.path) ?? group(file.path, depth);
    const entry = totals.get(key) ?? { added: 0, removed: 0, files: 0 };
    entry.added += file.additions;
    entry.removed += file.deletions;
    entry.files += 1;
    totals.set(key, entry);
  }
  let entries = [...totals].sort(
    (a, b) =>
      Number(a[0] === "Tests" || a[0] === "Docs") -
        Number(b[0] === "Tests" || b[0] === "Docs") ||
      b[1].added + b[1].removed - (a[1].added + a[1].removed),
  );
  if (entries.length > limit) {
    const kept = entries.slice(0, limit - 1);
    const other = entries.slice(limit - 1).reduce(
      (sum, [, value]) => ({
        added: sum.added + value.added,
        removed: sum.removed + value.removed,
        files: sum.files + value.files,
      }),
      { added: 0, removed: 0, files: 0 },
    );
    entries = [...kept, ["Other", other]];
  }
  return {
    labels: entries.map(([label]) => label),
    added: entries.map(([, value]) => value.added),
    removed: entries.map(([, value]) => value.removed),
    files: entries.map(([, value]) => value.files),
  };
}

// ── Evidence resolution ─────────────────────────────────────────────────────

export interface ResolvedEvidence {
  path: string;
  /** The line the evidence actually points at, after resolution. */
  line: number | null;
  note: string;
  side: Side;
  /**
   * resolved: the model's quote was found at `line` in that commit.
   * unverified: no quote was given; the file and line exist but nothing more is known.
   * unresolved: the quote, file, or line was not found.
   */
  status: "resolved" | "unverified" | "unresolved";
  /** The line the model cited, when resolution moved it. */
  citedLine: number | null;
  url: string;
}

export interface SourceReader {
  /** File text at that side, or null when absent/unreadable. */
  read(side: Side, path: string): string | null;
}

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

export function blobUrl(pr: PullRequest, side: Side, path: string, line: number | null) {
  const sha = side === "base" ? pr.baseSha : pr.headSha;
  const encoded = path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://${pr.host}/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/blob/${sha}/${encoded}${line ? `#L${line}` : ""}`;
}

function locate(text: string, quote: string, near: number | null) {
  const needle = normalize(quote);
  if (!needle) return null;
  const hits: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (normalize(line).includes(needle)) hits.push(index + 1);
  });
  if (!hits.length) return null;
  return near === null
    ? hits[0]!
    : hits.reduce((best, hit) =>
        Math.abs(hit - near) < Math.abs(best - near) ? hit : best,
      );
}

/**
 * Resolves one model citation against the real files. `preferred` is the side
 * the citation describes (before → base, everything else → head); a quote that
 * only exists on the other side moves the citation there.
 */
export function resolveEvidence(
  pr: PullRequest,
  evidence: EvidenceItem,
  preferred: Side,
  sources: SourceReader | null,
): ResolvedEvidence {
  const cited = evidence.line ?? null;
  const other: Side = preferred === "base" ? "head" : "base";
  const result = (
    side: Side,
    line: number | null,
    status: ResolvedEvidence["status"],
  ): ResolvedEvidence => ({
    path: evidence.path,
    line,
    note: evidence.note,
    side,
    status,
    citedLine: line !== cited ? cited : null,
    url: blobUrl(pr, side, evidence.path, line),
  });
  if (!sources) return result(preferred, cited, "unverified");
  if (evidence.quote) {
    for (const side of [preferred, other]) {
      const text = sources.read(side, evidence.path);
      const line = text === null ? null : locate(text, evidence.quote, cited);
      if (line !== null) return result(side, line, "resolved");
    }
    return result(preferred, cited, "unresolved");
  }
  for (const side of [preferred, other]) {
    const text = sources.read(side, evidence.path);
    if (text === null) continue;
    const lines = text.split("\n").length;
    if (cited === null || cited <= lines)
      return result(side, cited, "unverified");
  }
  return result(preferred, cited, "unresolved");
}

type Resolved<T> = T extends EvidenceItem
  ? ResolvedEvidence
  : T extends (infer U)[]
    ? Resolved<U>[]
    : T extends object
      ? { [K in keyof T]: Resolved<T[K]> }
      : T;
export type ResolvedDocument = Resolved<BriefingDocument>;

/** Returns the document with every citation resolved; before-evidence prefers base. */
export function resolveDocument(
  pr: PullRequest,
  document: BriefingDocument,
  sources: SourceReader | null,
): ResolvedDocument {
  const cache = new Map<string, ResolvedEvidence>();
  const resolve = (items: EvidenceItem[], side: Side) =>
    items.map((item) => {
      const key = `${side}\0${item.path}\0${item.line ?? ""}\0${item.quote ?? ""}\0${item.note}`;
      const hit = cache.get(key) ?? resolveEvidence(pr, item, side, sources);
      cache.set(key, hit);
      return hit;
    });
  return {
    ...document,
    summary: document.summary.map((item) => ({
      ...item,
      evidence: resolve(item.evidence, "head"),
    })),
    behavior: {
      ...document.behavior,
      beforeEvidence: resolve(document.behavior.beforeEvidence, "base"),
      afterEvidence: resolve(document.behavior.afterEvidence, "head"),
    },
    impacts: document.impacts.map((item) => ({
      ...item,
      evidence: resolve(item.evidence, "head"),
    })),
    considerations: document.considerations.map((item) => ({
      ...item,
      evidence: resolve(item.evidence, "head"),
    })),
  } as ResolvedDocument;
}

/** Every citation once, in reading order. */
export function allEvidence(document: ResolvedDocument) {
  const seen = new Set<string>();
  return [
    ...document.summary.flatMap((item) => item.evidence),
    ...document.behavior.beforeEvidence,
    ...document.behavior.afterEvidence,
    ...document.impacts.flatMap((item) => item.evidence),
    ...document.considerations.flatMap((item) => item.evidence),
  ].filter((item) => {
    const key = `${item.side}:${item.path}:${item.line ?? ""}:${item.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── CI checks ───────────────────────────────────────────────────────────────

export interface CheckRun {
  name: string;
  state: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  link: string | null;
  workflow: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** Maps the GitHub check-runs API response to `gh pr checks --json` vocabulary. */
export function normalizeCheckRuns(raw: unknown): CheckRun[] {
  const runs =
    raw && typeof raw === "object" && Array.isArray((raw as any).check_runs)
      ? ((raw as any).check_runs as any[])
      : [];
  const text = (value: unknown, max = 200) =>
    typeof value === "string" ? value.slice(0, max) : null;
  return runs.slice(0, 100).map((run) => {
    const status = text(run?.status) ?? "queued";
    const conclusion = text(run?.conclusion);
    const bucket: CheckRun["bucket"] =
      status !== "completed"
        ? "pending"
        : conclusion === "success"
          ? "pass"
          : conclusion === "skipped" || conclusion === "neutral"
            ? "skipping"
            : conclusion === "cancelled"
              ? "cancel"
              : "fail";
    const link = text(run?.html_url, 2048);
    return {
      name: text(run?.name) ?? "check",
      state: (conclusion ?? status).toUpperCase(),
      bucket,
      link: link && /^https:\/\//.test(link) ? link : null,
      workflow: text(run?.app?.name),
      startedAt: text(run?.started_at, 40),
      completedAt: text(run?.completed_at, 40),
    };
  });
}

// ── Visual before/after ─────────────────────────────────────────────────────

export interface VisualImage {
  mime: string;
  ext: string;
  bytes: Buffer;
}
export interface VisualPair {
  label: string;
  path: string;
  before: VisualImage | null;
  after: VisualImage | null;
  identical: boolean;
}
export interface BinaryReader {
  readBytes(side: Side, path: string): Buffer | null;
}

const IMAGE_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const MAX_VISUAL_BYTES = 512 * 1024;
const MAX_INLINE_SVG = 20 * 1024;
const INLINE_SVG = /<svg\b[\s\S]*?<\/svg>/gi;

function svgImage(markup: string): VisualImage {
  const withNamespace = /\sxmlns=/.test(markup.slice(0, markup.indexOf(">")))
    ? markup
    : markup.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return { mime: "image/svg+xml", ext: "svg", bytes: Buffer.from(withNamespace) };
}

/**
 * Before/after pairs that need no app run: changed image files, and inline
 * static SVG markup replaced by other static SVG markup in the same hunk.
 * Images are only ever shown as <img>/image files, which cannot run scripts.
 */
export function visualPairs(
  files: DiffFile[],
  reader: BinaryReader,
  limit = 8,
  budget = 2 * 1024 * 1024,
): VisualPair[] {
  const pairs: VisualPair[] = [];
  let spent = 0;
  const push = (pair: VisualPair) => {
    const size = (pair.before?.bytes.length ?? 0) + (pair.after?.bytes.length ?? 0);
    if (spent + size > budget) return;
    spent += size;
    pairs.push(pair);
  };
  for (const file of files) {
    if (pairs.length >= limit) break;
    const ext = /\.([a-z0-9]+)$/i.exec(file.path)?.[1]?.toLowerCase() ?? "";
    const mime = IMAGE_TYPES[ext];
    if (!mime) continue;
    const image = (side: Side, path: string | null): VisualImage | null => {
      if (!path) return null;
      const bytes = reader.readBytes(side, path);
      return bytes && bytes.length <= MAX_VISUAL_BYTES ? { mime, ext, bytes } : null;
    };
    const before = file.status === "added" ? null : image("base", file.oldPath ?? file.path);
    const after = file.status === "deleted" ? null : image("head", file.path);
    if (!before && !after) continue;
    push({
      label: file.status === "added" ? `${file.path} (new)` : file.status === "deleted" ? `${file.path} (deleted)` : file.path,
      path: file.path,
      before,
      after,
      identical: !!before && !!after && before.bytes.equals(after.bytes),
    });
  }
  for (const file of files) {
    if (IMAGE_TYPES[/\.([a-z0-9]+)$/i.exec(file.path)?.[1]?.toLowerCase() ?? ""]) continue;
    for (const hunk of file.hunks) {
      if (pairs.length >= limit) return pairs;
      const side = (prefix: string) =>
        hunk.lines
          .filter((line) => line.startsWith(prefix))
          .map((line) => line.slice(1))
          .join("\n");
      // Pair by position only when both sides hold the same number of SVGs,
      // and only positions where both are static (no template expressions).
      const svgs = (text: string) => [...text.matchAll(INLINE_SVG)].map((match) => match[0]);
      const isStatic = (svg: string) => svg.length <= MAX_INLINE_SVG && !/[{}]/.test(svg);
      const removed = svgs(side("-"));
      const added = svgs(side("+"));
      if (!removed.length || removed.length !== added.length) continue;
      removed.forEach((old, index) => {
        if (pairs.length >= limit) return;
        const next = added[index]!;
        if (!isStatic(old) || !isStatic(next) || normalize(old) === normalize(next)) return;
        push({
          label: `${file.path} · inline SVG near line ${hunk.newStart}`,
          path: file.path,
          before: svgImage(old),
          after: svgImage(next),
          identical: false,
        });
      });
    }
  }
  return pairs;
}

// ── Code excerpts ───────────────────────────────────────────────────────────

export interface KeyHunk {
  path: string;
  patch: string;
}

/** One representative hunk (≤ 40 lines), preferring files the after-evidence cites. */
export function keyHunk(files: DiffFile[], preferredPaths: string[]): KeyHunk | null {
  const candidates = files.flatMap((file) =>
    file.hunks
      .filter((hunk) => hunk.lines.length <= 40)
      .map((hunk) => ({
        file,
        hunk,
        score:
          (preferredPaths.includes(file.path) ? 0 : 100) +
          (hunk.lines.some((l) => l.startsWith("+")) && hunk.lines.some((l) => l.startsWith("-")) ? 0 : 50) +
          (TEST_PATH.test(file.path) || DOC_PATH.test(file.path) ? 200 : 0),
      })),
  );
  candidates.sort((a, b) => a.score - b.score || a.hunk.lines.length - b.hunk.lines.length);
  const best = candidates[0];
  if (!best) return null;
  const oldPath = best.file.status === "added" ? "/dev/null" : `a/${best.file.oldPath ?? best.file.path}`;
  const newPath = best.file.status === "deleted" ? "/dev/null" : `b/${best.file.path}`;
  return {
    path: best.file.path,
    patch: [`--- ${oldPath}`, `+++ ${newPath}`, best.hunk.header, ...best.hunk.lines].join("\n"),
  };
}

export interface CodeExcerpt {
  path: string;
  side: Side;
  from: number;
  to: number;
  focus: number;
  code: string;
  note: string;
  url: string;
}

/** Up to `limit` short excerpts around resolved citations, distinct by location. */
export function codeExcerpts(
  evidence: ResolvedEvidence[],
  sources: SourceReader,
  limit = 4,
  radius = 5,
): CodeExcerpt[] {
  const out: CodeExcerpt[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    if (out.length >= limit) break;
    if (item.status !== "resolved" || item.line === null) continue;
    const key = `${item.side}:${item.path}:${Math.floor(item.line / 20)}`;
    if (seen.has(key)) continue;
    const text = sources.read(item.side, item.path);
    if (text === null) continue;
    const lines = text.replace(/\r?\n$/, "").split("\n");
    const from = Math.max(1, item.line - radius);
    const to = Math.min(lines.length, item.line + radius);
    seen.add(key);
    out.push({
      path: item.path,
      side: item.side,
      from,
      to,
      focus: item.line,
      code: lines.slice(from - 1, to).join("\n"),
      note: item.note,
      url: item.url,
    });
  }
  return out;
}

// ── Verified vs claimed ─────────────────────────────────────────────────────

export type AcceptanceStatus = "passed" | "failed" | "untested" | "claimed";
export interface AcceptanceRow {
  name: string;
  status: AcceptanceStatus;
  by: string;
  note: string | null;
  needs: string | null;
}

export function evidenceCounts(evidence: ResolvedEvidence[]) {
  return {
    total: evidence.length,
    resolved: evidence.filter((item) => item.status === "resolved").length,
    unverified: evidence.filter((item) => item.status === "unverified").length,
    unresolved: evidence.filter((item) => item.status === "unresolved").length,
  };
}

export function checkCounts(checks: CheckRun[] | null) {
  if (!checks) return null;
  return {
    total: checks.length,
    passed: checks.filter((check) => check.bucket === "pass").length,
    failed: checks.filter((check) => check.bucket === "fail").length,
    pending: checks.filter((check) => check.bucket === "pending").length,
  };
}

export function acceptanceRows(options: {
  document: ResolvedDocument;
  checks: CheckRun[] | null;
  visuals: VisualPair[];
}): AcceptanceRow[] {
  const evidence = evidenceCounts(allEvidence(options.document));
  const quoted = evidence.resolved + evidence.unresolved;
  const rows: AcceptanceRow[] = [];
  rows.push({
    name: "Quoted citations match the code",
    status: !quoted ? "untested" : evidence.unresolved ? "failed" : "passed",
    by: "evidence resolver",
    note: !quoted
      ? "No citation carried a quote to check."
      : `${evidence.resolved} of ${quoted} quoted citation${quoted === 1 ? "" : "s"} found in the cited commit${evidence.unresolved ? `; ${evidence.unresolved} not found` : ""}.`,
    needs: null,
  });
  if (evidence.unverified)
    rows.push({
      name: `${evidence.unverified} citation${evidence.unverified === 1 ? "" : "s"} without a quote`,
      status: "claimed",
      by: "model",
      note: "The file and line exist, but the cited code was not checked.",
      needs: null,
    });
  const checks = checkCounts(options.checks);
  rows.push(
    !checks
      ? { name: "CI passes on the briefed head", status: "untested", by: "GitHub checks", note: "Check runs could not be read.", needs: null }
      : !checks.total
        ? { name: "CI passes on the briefed head", status: "untested", by: "GitHub checks", note: "No check runs reported for this head.", needs: null }
        : {
            name: "CI passes on the briefed head",
            status: checks.failed ? "failed" : checks.pending ? "untested" : "passed",
            by: "GitHub checks",
            note: `${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending of ${checks.total}.`,
            needs: checks.pending ? "Wait for the pending checks" : null,
          },
  );
  if (options.visuals.length) {
    const changed = options.visuals.filter((pair) => !pair.identical).length;
    rows.push({
      name: "Visual changes are intended",
      status: changed ? "untested" : "passed",
      by: changed ? "reviewer" : "byte comparison",
      note: changed
        ? `${changed} of ${options.visuals.length} image${options.visuals.length === 1 ? "" : "s"} differ between base and head.`
        : "Every compared image is byte-identical.",
      needs: changed ? "Compare the before/after images" : null,
    });
  }
  for (const invariant of options.document.boundaries.unchanged.slice(0, 5))
    rows.push({ name: invariant, status: "claimed", by: "model", note: "Stated by the briefing model; not independently checked.", needs: null });
  return rows;
}

// ── Assembly ────────────────────────────────────────────────────────────────

export interface BriefingFacts {
  document: ResolvedDocument;
  files: Array<{ path: string; status: DiffFile["status"]; additions: number; deletions: number }>;
  areas: AreaBreakdown;
  /** null when check runs could not be read. */
  checks: CheckRun[] | null;
  visuals: VisualPair[];
  keyHunk: KeyHunk | null;
  excerpts: CodeExcerpt[];
  acceptance: AcceptanceRow[];
}

const NO_SOURCES: SourceReader & BinaryReader = {
  read: () => null,
  readBytes: () => null,
};

/**
 * Builds every deterministic fact for a briefing. With no `sources` (tests,
 * legacy callers) citations are reported as unverified rather than missing.
 */
export function buildFacts(options: {
  pr: PullRequest;
  document: BriefingDocument;
  diff: string;
  sources?: (SourceReader & BinaryReader) | null;
  checks?: CheckRun[] | null;
}): BriefingFacts {
  const sources = options.sources ?? null;
  const reader = sources ?? NO_SOURCES;
  const document = resolveDocument(options.pr, options.document, sources);
  const files = parseUnifiedDiff(options.diff);
  const visuals = visualPairs(files, reader);
  const checks = options.checks ?? null;
  const after = document.behavior.afterEvidence;
  return {
    document,
    files: files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
    areas: areaBreakdown(files),
    checks,
    visuals,
    keyHunk: keyHunk(files, after.map((item) => item.path)),
    excerpts: codeExcerpts([...after, ...allEvidence(document)], reader),
    acceptance: acceptanceRows({ document, checks, visuals }),
  };
}
