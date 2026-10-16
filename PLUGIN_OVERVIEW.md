## What you get

- A dedicated **PR Briefings** page for direct and configured team review requests.
- Request-category, repository, briefing-state, and text filters, plus update-time, changed-file, and repository sorting.
- Explicit generation from a discovered PR or canonical GitHub pull-request URL using Pi, Claude Code, or Codex.
- Queued, generating, ready, outdated, and failed states tied to the exact PR head.
- Self-contained reports opened in BB's host file preview, with source-linked evidence, before/after behavior, an impact map, flows, boundaries, and considerations.
- Reports separate what was verified from what the model only claims.
  - Citations are checked against the real base or head code and re-anchored.
  - CI checks are read from GitHub.
  - Changed images and inline SVG are shown before and after.
  - Where the change lands is charted, and the impact map is drawn as a graph.
- An optional **Discuss in chat** view renders the same briefing as interactive components when the Generative UI plugin is enabled.
- `bb pr-briefings status` and `bb pr-briefings generate <URL>` commands.
- Optional links to Pair Review details when that separate plugin is enabled.

Opening the page or viewing a pull request never starts generation. Pair Review and Generative UI are optional.

## Typical workflow

Open the review-request queue or paste a canonical pull-request URL, then explicitly generate a briefing for the exact current head with your configured provider. Open the finished report to understand the change before reading every file. If GitHub later reports a new head, the briefing becomes outdated and offers regeneration rather than silently describing stale code.

## How it works

The enrolled BB server uses authenticated GitHub CLI for discovery, PR metadata, repository cloning, and the exact comparison diff. Generation checks out the exact head in an isolated temporary directory. Repository content is treated as untrusted data, not instructions. Validated structured output is rendered through a deterministic local template.

Pi generation exposes only bounded read-only tools. Claude Code receives only its restricted read tool over a bounded source copy. Codex is rooted in that copy under its `read-only` sandbox; writes and direct network are blocked, while read access outside the copy follows the installed Codex policy. The supplied copy excludes credential-shaped paths, links, files over 256 KiB, and source beyond the total limit. Ambient provider API-key variables are not forwarded; use native CLI login stores. Temporary checkouts and copies are removed after every attempt.

Briefing state is stored in the plugin's BB-managed SQLite database. Private reports live under `~/.pr-briefings/briefs`. The plugin never comments, submits a review, edits PR metadata, pushes, or merges.

## Configuration

Use **Settings → Installed plugins → PR Briefings** or the sidebar-footer settings action. Choose:

- GitHub hostname: `github.com`
- Briefing provider: `pi`, `claude`, or `codex`
- Briefing model: `openai/gpt-5` by default; use an identifier understood by the selected provider
- Briefing reasoning: `medium`
- Review teams: empty; up to 20 comma-separated `OWNER/TEAM` values
- Teammate handles: empty; up to 100 handles used only for direct-request labels

GitHub and model credentials remain in native `gh`, Pi, Claude Code, or Codex stores; the plugin has no secret setting.

## Requirements

Requires BB 0.45 or newer, Plugin SDK 0.6.15 or newer, an enrolled server machine, Git, and authenticated GitHub CLI with repository read access. Configure one supported generation provider: Pi and its selected model, Claude Code CLI with a native login, or Codex CLI with a native login. Pi is not required for Claude or Codex generation.

PR URLs must be canonical HTTPS URLs on the configured hostname. Closed PRs, cross-repository fork heads, and complete comparison diffs over 512 KiB are unsupported. PR content and selected source are sent to the configured model provider under that provider's processing and retention terms.
