# PR Briefings for BB

PR Briefings turns a GitHub pull request into an evidence-backed visual explanation of its behavior change, affected surfaces, information flows, boundaries, and high-level risks. It is designed for review preparation: generation is explicit, viewing a PR never starts analysis, and the plugin does not comment on or modify the pull request.

## What you can do

- Open a dedicated **PR Briefings** page listing pull requests that directly request your review or request review from a configured team.
- Filter by request category, repository, briefing state, or text, and sort by update time, changed-file count, or repository.
- Generate a briefing for a discovered PR or an exact GitHub pull-request URL.
- Open a ready report in BB's host file preview. A report is tied to the exact PR head and is marked outdated when discovery sees a newer head.
- Read what the briefing **verified** apart from what the model only **claims**. Every citation is checked against the real code, CI checks are read from GitHub, and changed images are shown before and after.
- With the [Generative UI](https://github.com/ComicBit/bb-plugin-genui) plugin installed, choose **Discuss in chat** to see the same briefing as interactive components in a BB thread and ask follow-up questions.
- Open the source pull request, and, when the separate Pair Review plugin is available, open its matching details page.
- Inspect briefing state or queue a URL from the CLI.

## Prerequisites

- BB `>=0.45` with Plugin SDK `>=0.6.15` and an enrolled, connected BB server machine.
- Git and GitHub CLI (`gh`) available on that machine's `PATH`.
- `gh` authenticated for the configured GitHub hostname with read access to the repositories and pull requests. For the default host, verify with:

  ```sh
  gh auth status --hostname github.com
  ```

- One configured briefing provider on the server machine: Pi with a provider/model, an authenticated Claude Code CLI, or an authenticated Codex CLI.

Pi is optional. Choose **Claude** to use `claude` or **Codex** to use `codex` from the BB server's `PATH`; their native subscription logins are supported. For safety, Claude/Codex briefing subprocesses do not inherit ambient provider API-key variables, so authenticate the CLI itself. Browsing and filtering the GitHub queue or opening an existing report does not invoke any model.

Only canonical HTTPS PR URLs on the configured hostname are accepted. Query strings, fragments, encoded paths, closed PRs, and cross-repository fork heads are not supported. A complete comparison diff larger than 512 KiB is rejected instead of being partially briefed.

## Installation

Install the latest compatible 0.1 release from GitHub:

```sh
bb plugin install 'git:https://github.com/jgarrow-springhealth/bb-plugin-pr-briefings.git@^0.1.0'
```

BB asks for confirmation because third-party plugins run with full trust. Prefer a tagged release or explicit ref when one is available.

For a local development checkout:

```sh
bb plugin install .
bb plugin reload pr-briefings
```

## Open and use PR Briefings

1. Open **PR Briefings** in the BB sidebar. The page requests a GitHub refresh when it opens; **Refresh PRs** repeats discovery.
2. Optionally filter or sort **PRs needing review**. Team requests appear only for teams configured in plugin settings.
3. Choose **Generate** on a discovered PR, or paste a canonical PR URL into **Brief any pull request**.
4. Generation is queued and runs on the enrolled BB server machine. Keep the plugin enabled while it completes.
5. Choose **Open briefing** when the report is ready. If the PR head changes, choose **Regenerate** to brief the new head.

Opening the page, filtering, viewing a pull request, or opening a report never starts generation. Generation begins only from **Generate**, **Regenerate**, the generation CLI command, or a compatible plugin RPC caller.

### What a report contains

**Open briefing** shows the report inside the PR Briefings page. Links in the report (the pull request, evidence, CI checks) open through BB's normal link handling. **Open as file** still opens the raw HTML in BB's file preview, but BB's preview sandbox blocks links there.

Reports are static HTML laid out as one card, the same layout the chat view uses. The header shows the verdict, four metrics (files, lines added and removed, CI, and citations matched), and a **Remember this** note. The rest is split into tabs, which switch with plain CSS:

- **Overview:** plain-language summary rows with their evidence locations, and a chart of lines added (green) and removed (red) by area.
- **Before / after:** the change three ways.
  - *In words:* the before and after behavior.
  - *In the code:* one to three hunks the model picked, each with a "What to notice" caption. PR Briefings finds each one in the diff by an exact line.
  - *On screen:* screenshots attached to the PR description or its comments, side by side when they're labeled Before and After. Changed image files appear here too. Screen recordings are linked, not embedded.
- **Impact & flow:** an Excalidraw-style ("sketch") diagram of what the change touches. Select a box to jump to that part's card. Each flow is drawn as sketched steps with a numbered explanation.
- **Verified:** what PR Briefings checked itself (quoted citations, CI) versus what is only the model's claim, plus anything that needs a person. The model's claims and the "needs you" items are a checklist you tick off while reviewing. Ticks are saved in the plugin's database and cleared whenever the briefing is regenerated, because a new briefing comes with newly written claims. Ticks only save in the in-app viewer, not in **Open as file**.
- **Risks:** the model's spots worth a closer look, grouped by severity. Each says how to check it and where to look. These are not confirmed bugs.
- **Evidence:** numbered sources with their match status, the code at the cited lines, the scope boundaries, and the generation snapshot.

The sketch diagrams are drawn on the server with [roughjs](https://roughjs.com) (the library Excalidraw uses) in Excalifont, which is embedded in the report and licensed under the SIL Open Font License (`assets/fonts/Excalifont-OFL.txt`).

#### Screenshots

Briefings show screenshots only when the PR already includes them.

- **Where they come from:** PR Briefings reads GitHub's rendered HTML for the PR description and up to 50 comments, and keeps only pasted image attachments. It skips badges, avatars, and external sites.
- **How they're downloaded:** through GitHub's short-lived signed links, without sending credentials.
- **Limits:**
  - at most 8 screenshots and 3 MiB in total
  - only real PNG, JPEG, GIF, or WebP files are accepted
- **What it won't do:** PR Briefings doesn't run the PR's branch to take its own screenshots.

Each report also saves the validated model output privately beside it (`<head>.json`), so a report can be rebuilt without another model run.

How citations are checked:

- The model returns a short exact `quote` with each citation.
- The generator looks for that quote in the cited file at the base or head commit, and moves the line when it finds it elsewhere.
- A citation whose quote isn't found is marked **not found**.
- A citation without a quote is marked **unchecked**.
- Model output still never writes HTML: the report is rendered deterministically from validated JSON and computed facts.

### Discuss in chat (optional)

When the Generative UI plugin (`genui`) is enabled, each ready, current briefing has a **Discuss in chat** action.

- **What gets written:** generation writes a `<head>.genui/` bundle beside the report: data, a fixed `ui` spec, copies of cited files, and images.
- **How it opens:** the action opens BB's new-thread composer with a prefilled prompt. The prompt asks the agent to copy the bundle into the thread's storage, then repeat the spec verbatim, so Generative UI can render it. You choose the project and agent before sending.
- **Same machine required:** the thread must run on the BB server machine that holds `~/.pr-briefings`.
- **Fixed spec:** the spec is a constant template. Model text reaches it only as data and is escaped so it can't add links, images, or actions.
- **Follow-up questions are fixed too:** the suggested questions are fixed text, never model output.

### CLI

```sh
bb pr-briefings status
bb pr-briefings generate https://github.com/OWNER/REPO/pull/123
```

Successful commands return JSON. `status` lists stored briefing records; `generate` validates the URL against the current configured hostname before queueing it. Invalid input exits nonzero and creates no briefing record.

## Configuration

Open **Settings → Installed plugins → PR Briefings**, or choose **PR Briefings settings** in BB's sidebar footer. BB renders and persists the native settings form, shows validation feedback, and provides **Reset all to defaults** in the configuration notes section. The same values can be managed with `bb plugin config pr-briefings`.

| Setting | Default | Behavior |
| --- | --- | --- |
| GitHub hostname | `github.com` | Lowercase hostname used for `gh` API reads, repository cloning, and accepted PR URLs. Applies on the next discovery or generation operation. |
| Briefing provider | `pi` | Generation agent: Pi SDK, Claude Code CLI, or Codex CLI. |
| Briefing model | `openai/gpt-5` | Model identifier understood by the selected provider, such as `openai/gpt-5`, `opus`, or a Codex model ID. |
| Briefing reasoning | `medium` | Requested reasoning level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| Review teams | Empty | Up to 20 comma-separated `OWNER/TEAM` values added to team-review-request discovery. |
| Teammate GitHub handles | Empty | Up to 100 handles used only to classify direct requests as **Teammate** or **Other**. It does not change GitHub discovery. |

Defaults preserve the original Pi behavior. Credentials are not plugin settings: GitHub authentication remains in `gh`, while model credentials remain in Pi, Claude Code, or Codex's native credential store.

## Permissions, data, and external services

- **GitHub:** the host worker uses authenticated `gh` API reads for the current user, search, PR metadata, the exact comparison diff, and the head commit's check runs. It clones and fetches the selected repository into a temporary checkout, including the base commit's objects so before-evidence can be checked. It does not submit reviews or comments, change PR metadata, push, merge, or request write permission.
- **Model provider:** the selected Pi, Claude Code, or Codex transport sends the prompt, PR metadata, diff, and inspected source to its configured model service. Provider retention and processing follow that provider's terms.
- **Local files and processes:** generation invokes `gh` and `git`, creates an isolated checkout at the exact PR head, and removes it after the attempt. Pi receives bounded read-only tools. Claude receives only its restricted read tool over a bounded source copy. Codex is rooted in the same copy under its `read-only` sandbox; direct network and writes are blocked, while read access outside the copy follows the installed Codex policy. Credential-shaped paths and links are excluded from the supplied copy.
- **Stored data:** queue and briefing state live in the plugin's BB-managed SQLite database. Generated reports and their Generative UI bundles live under `~/.pr-briefings/briefs` on the server machine. Directories use private permissions and files use mode `0600`. A bundle holds copies of up to 3 MiB of cited source and changed images.
- **Optional integrations:** Pair Review and Generative UI are not required.
  - When an enabled Pair Review app is detected, PR Briefings adds links to the matching Pair Review details page.
  - When Generative UI is enabled, it adds **Discuss in chat**. That thread's agent copies the bundle into its thread storage, so the briefing's content reaches the thread's model provider.

## Development and verification

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` runs `bb plugin build`.

Model output is validated strictly for safety (repository-relative paths, control characters, types) and leniently for presentation. Ordinary variation is normalized instead of failing the briefing: extra keys, loose labels, long text, PRs that only add or delete files, and tiny PRs. The suite guards this in two places:

- `tests/pr-shapes.test.ts` runs realistic answers for different PR shapes through the whole pipeline: add-only, delete-only, rename-only, docs-only, image-only, a one-line fix, a large PR, messy output, and output that must still fail.
- `tests/golden.test.ts` re-validates real accepted output kept in `tests/fixtures/`. Add fixtures from public PRs only, using the `<head>.json` that each briefing saves. The unit and frontend tests use BB's plugin harness and do not prove live GitHub authentication, provider access, generated-report quality, or host file-preview behavior.

## Screenshots

A report generated from a public pull request leads with the product's primary
outcome: an evidence-backed explanation of behavior, impact, flows, and scope:

![Generated PR briefing](docs/screenshots/generated-report.png)

The queue and generation surface shows request-category controls and filters;
live counts and pull-request cards are omitted:

![PR Briefings queue and generation controls](docs/screenshots/queue.png)

The native BB settings page exposes discovery and generation configuration.
Private team and teammate values are irreversibly redacted, and the capture
excludes the unrelated installed-plugin list:

![PR Briefings settings in BB](docs/screenshots/settings.png)

Private development captures are intentionally excluded from this public tree. Only sanitized release screenshots belong under `docs/screenshots/`.

## License

MIT © 2026 Janessa Garrow. See [LICENSE](LICENSE).
