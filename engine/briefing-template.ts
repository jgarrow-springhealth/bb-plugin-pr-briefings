import { z } from "zod";

const Copy = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), {
      message: "Text contains control characters",
    });
const RepositoryPath = Copy(500).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === ".."),
  { message: "Evidence path must be repository-relative" },
);
const Evidence = z
  .object({
    path: RepositoryPath,
    line: z.number().int().positive().max(10_000_000).optional(),
    /** Exact text from the cited line, used to verify and re-anchor the citation. */
    quote: Copy(200).optional(),
    note: Copy(300),
  })
  .strict();
export type EvidenceItem = z.infer<typeof Evidence>;
const EvidenceList = z.array(Evidence).max(8);
const ImpactId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const Impact = z
  .object({
    /** Short slug other impacts can reference in `dependsOn`. */
    id: ImpactId.optional(),
    /** Impacts this one is reached through or depends on; draws the impact graph. */
    dependsOn: z.array(ImpactId).max(12).optional(),
    /** Short label for how this impact uses the ones in dependsOn (edge label). */
    relation: Copy(60).optional(),
    name: Copy(120),
    kind: z.enum([
      "product surface",
      "service",
      "package",
      "data",
      "team",
      "operations",
    ]),
    changed: z.boolean(),
    change: Copy(360),
    evidence: EvidenceList,
  })
  .strict();
const Flow = z
  .object({
    title: Copy(160),
    steps: z
      .array(
        z
          .object({
            label: Copy(100),
            detail: Copy(260),
            changed: z.boolean(),
          })
          .strict(),
      )
      .min(2)
      .max(8)
      .refine((steps) => steps.filter((step) => step.changed).length <= 1, {
        message: "A flow can mark at most one changed step",
      }),
  })
  .strict();
export const BriefingDocument = z
  .object({
    verdict: Copy(320),
    summary: z
      .array(
        z
          .object({
            kind: z.enum(["behavior", "surface", "scope", "compatibility"]),
            claim: Copy(500),
            evidence: EvidenceList.min(1).max(4),
          })
          .strict(),
      )
      .min(3)
      .max(6),
    behavior: z
      .object({
        before: Copy(1200),
        beforeEvidence: EvidenceList.min(1).max(4),
        after: Copy(1200),
        afterEvidence: EvidenceList.min(1).max(4),
        /** Hunks that best show the change, located in the diff by an exact line. */
        examples: z
          .array(
            z
              .object({
                path: RepositoryPath,
                quote: Copy(200),
                caption: Copy(240),
              })
              .strict(),
          )
          .max(3)
          .optional(),
      })
      .strict(),
    impacts: z
      .array(Impact)
      .min(1)
      .max(12)
      .refine((items) => items.filter((item) => item.changed).length <= 1, {
        message: "An impact map can mark at most one changed item",
      }),
    flows: z.array(Flow).max(3),
    boundaries: z
      .object({
        inScope: z.array(Copy(400)).min(1).max(10),
        outOfScope: z.array(Copy(400)).min(1).max(10),
        unchanged: z.array(Copy(400)).min(1).max(10),
      })
      .strict(),
    considerations: z
      .array(
        z
          .object({
            level: z.enum(["note", "watch", "risk"]),
            title: Copy(140),
            detail: Copy(700),
            /** What a reviewer can do to confirm or rule this out. */
            check: Copy(300).optional(),
            evidence: EvidenceList,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type BriefingDocument = z.infer<typeof BriefingDocument>;

function trimValidatedEvidence(value: unknown, maximum: number) {
  if (!Array.isArray(value)) return value;
  // Validate every model-authored reference before applying the presentation
  // bound so an unsafe path cannot be hidden in a discarded entry.
  return z.array(Evidence).parse(value).slice(0, maximum);
}

function normalizeEvidenceCardinality(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const document = value as Record<string, unknown>;
  const summary = Array.isArray(document.summary)
    ? document.summary.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? {
              ...(item as Record<string, unknown>),
              evidence: trimValidatedEvidence(
                (item as Record<string, unknown>).evidence,
                4,
              ),
            }
          : item,
      )
    : document.summary;
  const behavior =
    document.behavior &&
    typeof document.behavior === "object" &&
    !Array.isArray(document.behavior)
      ? {
          ...(document.behavior as Record<string, unknown>),
          beforeEvidence: trimValidatedEvidence(
            (document.behavior as Record<string, unknown>).beforeEvidence,
            4,
          ),
          afterEvidence: trimValidatedEvidence(
            (document.behavior as Record<string, unknown>).afterEvidence,
            4,
          ),
        }
      : document.behavior;
  const normalizeEight = (items: unknown) =>
    Array.isArray(items)
      ? items.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? {
                ...(item as Record<string, unknown>),
                evidence: trimValidatedEvidence(
                  (item as Record<string, unknown>).evidence,
                  8,
                ),
              }
            : item,
        )
      : items;
  return {
    ...document,
    summary,
    behavior,
    impacts: singleChanged(normalizeEight(completeImpacts(document.impacts))),
    flows: Array.isArray(document.flows)
      ? document.flows.map((flow) =>
          flow && typeof flow === "object" && !Array.isArray(flow)
            ? {
                ...(flow as Record<string, unknown>),
                steps: singleChanged((flow as Record<string, unknown>).steps),
              }
            : flow,
        )
      : document.flows,
    considerations: normalizeEight(document.considerations),
  };
}

/**
 * Models sometimes leave "changed"/"change" off impacts they don't consider the
 * change itself, or name the description differently. Fill those in instead of
 * failing the whole briefing; anything else still has to validate.
 */
function completeImpacts(items: unknown) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = { ...(item as Record<string, unknown>) };
    if (record.changed === undefined) record.changed = false;
    if (record.change === undefined) {
      const alternate = ["description", "detail", "summary", "effect", "impact"].find((key) => typeof record[key] === "string" && (record[key] as string).trim());
      if (alternate) record.change = record[alternate];
      else if (typeof record.relation === "string" && record.relation.trim()) record.change = record.relation;
    }
    for (const key of ["description", "detail", "summary", "effect", "impact"]) delete record[key];
    return record;
  });
}

/**
 * Presentation rule: an impact map (or a flow) highlights one changed item.
 * Models sometimes mark several; keep the first instead of failing the briefing.
 */
function singleChanged(items: unknown) {
  if (!Array.isArray(items)) return items;
  let seen = false;
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (record.changed !== true) return item;
    if (!seen) {
      seen = true;
      return item;
    }
    return { ...record, changed: false };
  });
}

export function parseBriefingDocument(output: string): BriefingDocument {
  if (Buffer.byteLength(output) > 2 * 1024 * 1024)
    throw Error(
      "Briefing model output exceeds the 2 MiB structured-data limit",
    );
  const unfenced = output
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start)
    throw Error("Briefing model did not return a JSON object");
  let value: unknown;
  try {
    value = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw Error("Briefing model returned invalid JSON");
  }
  return BriefingDocument.parse(normalizeEvidenceCardinality(value));
}

export { renderBriefingHtml } from "./briefing-render.ts";
