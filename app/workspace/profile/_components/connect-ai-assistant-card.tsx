"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { FAMILY_LABELS } from "@/convex/mcp/families";
import { useRole } from "@/components/auth/role-context";
import { ConnectionUrl } from "@/components/ai-assistants/connection-url";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { Fact, Facts, NoteLine, StatusWord } from "@/app/workspace/settings/_components/settings-ui";

const STEPS = {
  claude: [
    "Open Claude's connector settings and add a custom connector named Magnus.",
    "Paste the connection URL, connect, and sign in with your Magnus login.",
    'Ask "What is on my day in Magnus?"',
  ],
  chatgpt: [
    "Open ChatGPT's app settings and enable developer mode if needed to create a custom app.",
    "Create an app named Magnus using the connection URL and OAuth, then sign in with your Magnus login.",
    "Select Magnus in a chat and ask for your day.",
  ],
  terminal: [
    "In Claude Code, Hermes or another MCP-capable agent, add an HTTP MCP server named magnus.",
    "Use the connection URL as the server URL, then complete its OAuth sign-in with your Magnus login.",
    "Ask the agent to call magnus_today.",
  ],
} as const;

/** The last step for admins: their assistant has no closer day to ask about. */
const ADMIN_LAST_STEP: Record<keyof typeof STEPS, string> = {
  claude: 'Ask "How did the floor do today?"',
  chatgpt: "Select Magnus in a chat and ask how the floor did today.",
  terminal: "Ask the agent how the floor did today.",
};

const LEAD_GEN_LAST_STEP: Record<keyof typeof STEPS, string> = {
  claude: 'Ask "What does my lead gen shift look like in Magnus?"',
  chatgpt: "Select Magnus in a chat and ask for your shift.",
  terminal: "Ask the agent to call magnus_lead_gen_today.",
};

const ADMIN_PROMPTS = [
  "How did the floor do today?",
  "Which payments are waiting for review?",
  "Cover Alex tomorrow afternoon",
] as const;

/**
 * The closer's connection URL and setup steps, while AI assistants are on for
 * their role (docs/plans/closer-assistant.md §7). A blocked closer sees why.
 * Admins also see example prompts and which kinds of change their assistant
 * may make (docs/plans/admin-assistant.md §4).
 */
export function ConnectAiAssistantCard() {
  const access = useQuery(api.mcp.settings.getMyAiAssistantAccess);
  const { isAdmin, role } = useRole();
  if (!access?.roleEnabled) return null;
  return (
    <section aria-label="AI assistant" className={CARD}>
      <CardHead title="AI assistant">
        {access.blocked ? <StatusWord tone="warning">Blocked</StatusWord> : null}
      </CardHead>
      <div className="flex flex-col gap-1.5 border-b border-border px-4 py-2.5">
        {access.blocked ? (
          <NoteLine tone="warning" role="status">
            {isAdmin
              ? "Your AI assistant access is blocked. Ask the owner to unblock it."
              : "An admin blocked your AI assistant access. Ask them to unblock it."}
          </NoteLine>
        ) : null}
        <NoteLine>Paste this URL into your AI app&apos;s connectors, then sign in with your Magnus login.</NoteLine>
      </div>
      <Facts>
        <Fact label="Connection URL">
          <ConnectionUrl url={access.resourceUrl} />
        </Fact>
        {isAdmin ? (
          <Fact
            label="Can change"
            tip="The owner switches each kind of change on in Settings › Integrations. Every change is previewed first, and payment reviews, covering a closer and losses are approved in Magnus."
          >
            {access.writeFamilies.length ? (
              access.writeFamilies.map((family) => FAMILY_LABELS[family] ?? family).join(", ")
            ) : (
              <span className="text-muted-foreground">Nothing yet: your assistant reads only</span>
            )}
          </Fact>
        ) : null}
      </Facts>
      {isAdmin ? (
        <div className="flex flex-col gap-1.5 border-b border-border px-4 py-2.5">
          <NoteLine>Try asking:</NoteLine>
          <ul className="flex flex-col gap-1 text-sm">
            {ADMIN_PROMPTS.map((prompt) => (
              <li key={prompt}>&ldquo;{prompt}&rdquo;</li>
            ))}
          </ul>
          {access.writeFamilies.length ? (
            <NoteLine>If a kind of change was switched on after you connected, reconnect your assistant to see it.</NoteLine>
          ) : null}
        </div>
      ) : null}
      <Tabs defaultValue="claude" className="gap-2.5 px-4 py-3">
        <TabsList className="max-w-full">
          <TabsTrigger value="claude">Claude</TabsTrigger>
          <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
          <TabsTrigger value="terminal">Terminal agents</TabsTrigger>
        </TabsList>
        {(Object.keys(STEPS) as (keyof typeof STEPS)[]).map((client) => (
          <TabsContent key={client} value={client}>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-[1.45] text-muted-foreground">
              {(isAdmin
                ? [...STEPS[client].slice(0, -1), ADMIN_LAST_STEP[client]]
                : role === "lead_generator"
                  ? [...STEPS[client].slice(0, -1), LEAD_GEN_LAST_STEP[client]]
                  : STEPS[client]).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
