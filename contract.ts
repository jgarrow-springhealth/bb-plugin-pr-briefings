import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const thinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const provider = z.enum(["pi", "claude", "codex"]);
const hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    "Use a lowercase hostname such as github.com (without https://)",
  );
const model = z
  .string()
  .min(1, "Enter a model identifier")
  .max(200, "Model must be at most 200 characters")
  .regex(/^[\w./:+-]+$/, "Use a model identifier supported by the selected provider");

export function parseReviewTeams(value: string) {
  const teams = value
    .split(",")
    .map((team) => team.trim())
    .filter(Boolean);
  if (teams.length > 20) throw Error("At most 20 review teams are allowed");
  for (const team of teams)
    if (
      team.length > 201 ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(team)
    )
      throw Error(`Invalid review team: ${team}`);
  return [...new Set(teams)];
}

function validateTeammates(value: string) {
  const teammates = value.split(/[\s,]+/).filter(Boolean);
  if (teammates.length > 100)
    throw Error("At most 100 teammate handles are allowed");
  for (const teammate of teammates)
    if (!/^[A-Za-z0-9_.-]+$/.test(teammate))
      throw Error(`Invalid teammate handle: ${teammate}`);
}

export const Preferences = z
  .object({
    hostname,
    provider,
    model,
    thinking,
    teams: z
      .string()
      .max(4096, "Review teams must be at most 4096 characters")
      .refine((value) => {
        try {
          parseReviewTeams(value);
          return true;
        } catch {
          return false;
        }
      }, "Use comma-separated OWNER/TEAM values (maximum 20)"),
    teammates: z
      .string()
      .max(4096, "Teammate handles must be at most 4096 characters")
      .refine((value) => {
        try {
          validateTeammates(value);
          return true;
        } catch {
          return false;
        }
      }, "Use valid GitHub handles (maximum 100)"),
  })
  .strict();
export type Preferences = z.infer<typeof Preferences>;

export const DEFAULT_PREFERENCES: Preferences = {
  hostname: "github.com",
  provider: "pi",
  model: "openai/gpt-5",
  thinking: "medium",
  teams: "",
  teammates: "",
};

export const PullRequest = z
  .object({
    key: z.string(),
    url: z.string().url(),
    host: z.string(),
    owner: z.string(),
    repo: z.string(),
    number: z.number().int().positive(),
    title: z.string(),
    author: z.string(),
    baseBranch: z.string(),
    baseSha: sha,
    headBranch: z.string(),
    headSha: sha,
    updatedAt: z.string().nullable(),
    draft: z.boolean(),
    requestKinds: z
      .array(z.enum(["direct", "team"]))
      .max(2)
      .default([]),
    changedFiles: z.number().int().nonnegative().nullable(),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type PullRequest = z.infer<typeof PullRequest>;

export const BriefingStatus = z
  .object({
    available: z.boolean(),
    state: z.enum(["missing", "queued", "generating", "ready", "failed"]),
    head: sha.nullable(),
    file: z.string().nullable(),
    hostId: z.string().nullable(),
    stale: z.boolean(),
    error: z.string().nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type BriefingStatus = z.infer<typeof BriefingStatus>;

const briefingRecord = z
  .object({
    url: z.string().url(),
    title: z.string(),
    subject: z.string(),
    author: z.string(),
    head: sha.nullable(),
    state: z.enum(["queued", "generating", "ready", "failed"]),
    file: z.string().nullable(),
    /** Generative UI chat bundle next to the report, when one was written. */
    bundle: z.string().nullable(),
    hostId: z.string().nullable(),
    error: z.string().nullable(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type BriefingRecord = z.infer<typeof briefingRecord>;

export const hostContract = defineRpcContract({
  discover: {
    input: z
      .object({
        hostname,
        teams: z
          .array(
            z
              .string()
              .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
              .max(201),
          )
          .max(20),
      })
      .strict(),
    output: z.object({ prs: z.array(PullRequest).max(500) }).strict(),
  },
  generate: {
    input: z
      .object({
        url: z.string().url().max(2048),
        hostname,
        provider,
        model,
        thinking,
      })
      .strict(),
    output: z
      .object({
        pr: PullRequest,
        file: z.string(),
        bundle: z.string().nullable().default(null),
        generatedAt: z.number(),
      })
      .strict(),
  },
  /** Reads one generated report; the host only serves .html files under its briefs directory. */
  read_report: {
    input: z.object({ file: z.string().min(1).max(4096) }).strict(),
    output: z.object({ html: z.string() }).strict(),
  },
});

export const PullRequestUrl = z.string().url().max(2048);
const urlInput = z.object({ url: PullRequestUrl }).strict();
export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.null(),
    output: z
      .object({
        queue: z.array(PullRequest).max(500),
        briefings: z.array(briefingRecord).max(500),
        preferences: Preferences,
        pairReviewAvailable: z.boolean(),
        genuiAvailable: z.boolean(),
        refreshing: z.boolean(),
        warning: z.string().nullable(),
      })
      .strict(),
  },
  refresh: {
    input: z.null(),
    output: z.object({ accepted: z.literal(true) }).strict(),
  },
  briefing_get: {
    input: urlInput.extend({ head: sha.optional() }).strict(),
    output: BriefingStatus,
  },
  briefing_generate: {
    input: urlInput,
    output: BriefingStatus,
  },
  /** Review checklist ticks (Verified tab), saved per PR head. */
  checklist_get: {
    input: urlInput.extend({ head: sha }).strict(),
    output: z.object({ keys: z.array(z.string()).max(200) }).strict(),
  },
  checklist_set: {
    input: urlInput
      .extend({ head: sha, key: z.string().regex(/^[a-z]+-[a-z0-9]{1,13}$/), checked: z.boolean() })
      .strict(),
    output: z.object({ keys: z.array(z.string()).max(200) }).strict(),
  },
  /** The ready report's HTML, for the in-app viewer. */
  briefing_html: {
    input: urlInput,
    output: z.object({ html: z.string(), title: z.string(), subject: z.string(), head: sha.nullable() }).strict(),
  },
  reset_settings: {
    input: z.null(),
    output: Preferences,
  },
});
