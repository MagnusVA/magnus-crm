/** Shared by Convex and the web app: how an MCP client's name shows on records. */
const CLIENT_DISPLAY_NAMES: [RegExp, string][] = [
  [/chatgpt|openai/i, "ChatGPT"],
  [/claude[-_ ]?code/i, "Claude Code"],
  [/claude/i, "Claude"],
  [/hermes/i, "Hermes"],
  [/codex/i, "Codex"],
  [/cursor/i, "Cursor"],
];

/** Decision 26: known client names map to a display name, others show raw. */
export function clientDisplayName(clientName: string | undefined): string {
  if (!clientName || clientName === "unknown") return "an AI assistant";
  for (const [pattern, name] of CLIENT_DISPLAY_NAMES) {
    if (pattern.test(clientName)) return name;
  }
  return clientName;
}
