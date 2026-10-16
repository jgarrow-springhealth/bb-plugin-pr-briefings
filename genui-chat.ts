// Shared by the server, host worker, and app: no Node or browser imports.

/** Directory under a thread's storage that chat briefings are copied into. */
export const GENUI_STORAGE_DIR = "pr-briefings";

export function genuiBundleName(key: string, headSha: string) {
  return `${key}-${headSha.slice(0, 12)}`;
}

/** `<root>/briefs/<key>/<sha>.genui` → the bundle's name in thread storage. */
export function genuiBundleNameFromPath(path: string) {
  const match = /([a-f0-9]{24})[\\/]([a-f0-9]{40})\.genui$/.exec(path);
  return match ? genuiBundleName(match[1]!, match[2]!) : null;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The first message of a "Discuss in chat" thread. The agent copies the bundle
 * into the thread's storage (the only place Generative UI may read it from) and
 * replays the generated spec verbatim.
 */
export function genuiChatPrompt(options: {
  subject: string;
  head: string;
  bundle: string;
}) {
  const name = genuiBundleNameFromPath(options.bundle);
  if (!name) throw Error("Not a PR Briefings chat bundle");
  const target = `"$BB_THREAD_STORAGE/${GENUI_STORAGE_DIR}/${name}"`;
  return `Show my PR briefing for ${options.subject} (head ${options.head.slice(0, 7)}) from PR Briefings.

1. Copy its files into this thread's storage:
   mkdir -p ${target} && cp -R ${shellQuote(`${options.bundle}/.`)} ${target}/
2. Reply with one short sentence, then the exact contents of ${shellQuote(`${options.bundle}/briefing.ui`)} inside a \`\`\`ui code block. Do not change the block.`;
}
