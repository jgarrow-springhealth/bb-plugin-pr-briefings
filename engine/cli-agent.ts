import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export type BriefingProvider = "claude" | "codex";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 10_000;
const protectedParts = new Set([
  ".git",
  "node_modules",
  ".pi",
  ".pair-review",
  ".ssh",
  ".aws",
  ".config",
  ".gnupg",
  ".docker",
]);

function allowedRelativePath(path: string) {
  return !path.split(/[\\/]/).some((part) => {
    const lower = part.toLowerCase();
    return (
      !part ||
      part === "." ||
      part === ".." ||
      protectedParts.has(lower) ||
      lower === ".env" ||
      lower.startsWith(".env.") ||
      [".npmrc", ".pypirc", ".netrc", ".git-credentials"].includes(lower)
    );
  });
}

export function createReadOnlyWorkspace(sourceRoot: string) {
  const temporary = mkdtempSync(join(tmpdir(), "pr-briefing-agent-"));
  chmodSync(temporary, 0o700);
  const workspace = join(temporary, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  let total = 0;
  let files = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relative(sourceRoot, absolute);
      if (!allowedRelativePath(rel) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = lstatSync(absolute);
      if (
        stat.nlink > 1 ||
        stat.size > MAX_SOURCE_BYTES ||
        files >= MAX_WORKSPACE_FILES ||
        total + stat.size > MAX_WORKSPACE_BYTES
      )
        continue;
      const destination = resolve(workspace, rel);
      const destinationRelative = relative(workspace, destination);
      if (!destinationRelative || destinationRelative.startsWith("..")) continue;
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(absolute, destination);
      chmodSync(destination, 0o400);
      files++;
      total += stat.size;
    }
  };
  visit(sourceRoot);
  return {
    root: workspace,
    cleanup: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

function agentEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const names = [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "CODEX_HOME",
  ];
  return Object.fromEntries(
    names.flatMap((name) =>
      typeof source[name] === "string" ? [[name, source[name]!]] : [],
    ),
  );
}

export function briefingAgentInvocation(options: {
  provider: BriefingProvider;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  workspace: string;
  outputFile: string;
}) {
  if (options.provider === "claude") {
    const effort =
      options.thinking === "xhigh"
        ? "max"
        : ["off", "minimal"].includes(options.thinking)
          ? "low"
          : options.thinking;
    return {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "json",
        "--model",
        options.model,
        "--restricted",
        "--tools",
        "Read",
        "--permission-mode",
        "plan",
        "--permission-prompts",
        "none",
        "--strict-mcp-config",
        "--mcp-config",
        "{}",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--settings",
        '{"disableAllHooks":true}',
      ],
      env: { ...agentEnvironment(), CLAUDE_CODE_EFFORT_LEVEL: effort },
    };
  }
  const effort = options.thinking === "off" ? "minimal" : options.thinking;
  return {
    command: "codex",
    args: [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--output-last-message",
      options.outputFile,
      "--model",
      options.model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(effort)}`,
      "-C",
      options.workspace,
      "-",
    ],
    env: agentEnvironment(),
  };
}

export async function runBriefingCli(options: {
  provider: BriefingProvider;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  workspace: string;
  prompt: string;
  signal: AbortSignal;
}) {
  const outputFile = join(options.workspace, "..", "last-message.json");
  const invocation = briefingAgentInvocation({ ...options, outputFile });
  options.signal.throwIfAborted();
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.workspace,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let closed = false;
    const stop = () => {
      if (closed) return;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
    };
    const timeout = setTimeout(stop, 90 * 60_000);
    const abort = () => stop();
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop();
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      if (options.signal.aborted)
        return reject(options.signal.reason ?? Error("Briefing cancelled"));
      if (bytes > MAX_OUTPUT_BYTES)
        return reject(Error("Briefing provider output exceeded 2 MiB"));
      if (code !== 0)
        return reject(Error(stderr.trim() || `${invocation.command} exited ${code}`));
      try {
        if (options.provider === "claude") {
          const envelope = JSON.parse(stdout);
          if (typeof envelope?.result !== "string")
            throw Error("Claude did not return a briefing result");
          resolveResult(envelope.result);
        } else {
          if (lstatSync(outputFile).size > MAX_OUTPUT_BYTES)
            throw Error("Briefing provider output exceeded 2 MiB");
          resolveResult(readFileSync(outputFile, "utf8"));
        }
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(options.prompt);
  });
}
