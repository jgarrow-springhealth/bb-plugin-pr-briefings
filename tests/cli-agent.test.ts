import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  briefingAgentInvocation,
  createReadOnlyWorkspace,
  runBriefingCli,
} from "../engine/cli-agent";

describe("provider-neutral briefing agents", () => {
  test("copies bounded source but excludes credential-shaped files", () => {
    const source = mkdtempSync(join(tmpdir(), "briefing-source-"));
    mkdirSync(join(source, "src"));
    writeFileSync(join(source, "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(join(source, ".env.local"), "SECRET=do-not-copy\n");

    const workspace = createReadOnlyWorkspace(source);
    try {
      expect(readFileSync(join(workspace.root, "src", "index.ts"), "utf8")).toContain(
        "value",
      );
      expect(() => readFileSync(join(workspace.root, ".env.local"))).toThrow();
    } finally {
      workspace.cleanup();
    }
  });

  test("returns a fake Claude briefing result through the constrained CLI path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "briefing-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "briefing-bin-"));
    const executable = join(bin, "claude");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end",()=>process.stdout.write(JSON.stringify({result:'{"verdict":"ok"}'})));\n`,
    );
    chmodSync(executable, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      await expect(
        runBriefingCli({
          provider: "claude",
          model: "fake",
          thinking: "low",
          workspace,
          prompt: "Create a briefing",
          signal: new AbortController().signal,
        }),
      ).resolves.toBe('{"verdict":"ok"}');
    } finally {
      process.env.PATH = previous;
    }
  });

  test("returns a fake Codex briefing result through the constrained CLI path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "briefing-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "briefing-bin-"));
    const executable = join(bin, "codex");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nconst fs=require("fs"),a=process.argv.slice(2);\nprocess.stdin.resume();\nprocess.stdin.on("end",()=>fs.writeFileSync(a[a.indexOf("--output-last-message")+1],'{"verdict":"ok"}'));\n`,
    );
    chmodSync(executable, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      await expect(
        runBriefingCli({
          provider: "codex",
          model: "fake",
          thinking: "low",
          workspace,
          prompt: "Create a briefing",
          signal: new AbortController().signal,
        }),
      ).resolves.toBe('{"verdict":"ok"}');
    } finally {
      process.env.PATH = previous;
    }
  });

  test("builds read-only Claude and Codex invocations without ambient API keys", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "should-not-be-forwarded";
    try {
      const common = {
        model: "example-model",
        thinking: "medium" as const,
        workspace: "/tmp/safe-workspace",
        outputFile: "/tmp/output.json",
      };
      const claude = briefingAgentInvocation({ ...common, provider: "claude" });
      expect(claude.args).toContain("--restricted");
      expect(claude.args).toContain("Read");
      expect(claude.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(
        briefingAgentInvocation({
          ...common,
          provider: "claude",
          thinking: "xhigh",
        }).env.CLAUDE_CODE_EFFORT_LEVEL,
      ).toBe("max");

      const codex = briefingAgentInvocation({ ...common, provider: "codex" });
      expect(codex.args).toContain("read-only");
      expect(codex.args).toContain("--ignore-user-config");
      expect(codex.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
