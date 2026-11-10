"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
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

/**
 * The closer's connection URL and setup steps, while AI assistants are on for
 * their role (docs/plans/closer-assistant.md §7). A blocked closer sees why.
 */
export function ConnectAiAssistantCard() {
  const access = useQuery(api.mcp.settings.getMyAiAssistantAccess);
  if (!access?.roleEnabled) return null;
  return (
    <section aria-label="AI assistant" className={CARD}>
      <CardHead title="AI assistant">
        {access.blocked ? <StatusWord tone="warning">Blocked</StatusWord> : null}
      </CardHead>
      <div className="flex flex-col gap-1.5 border-b border-border px-4 py-2.5">
        {access.blocked ? (
          <NoteLine tone="warning" role="status">
            An admin blocked your AI assistant access. Ask them to unblock it.
          </NoteLine>
        ) : null}
        <NoteLine>Paste this URL into your AI app&apos;s connectors, then sign in with your Magnus login.</NoteLine>
      </div>
      <Facts>
        <Fact label="Connection URL">
          <ConnectionUrl url={access.resourceUrl} />
        </Fact>
      </Facts>
      <Tabs defaultValue="claude" className="gap-2.5 px-4 py-3">
        <TabsList className="max-w-full">
          <TabsTrigger value="claude">Claude</TabsTrigger>
          <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
          <TabsTrigger value="terminal">Terminal agents</TabsTrigger>
        </TabsList>
        {(Object.keys(STEPS) as (keyof typeof STEPS)[]).map((client) => (
          <TabsContent key={client} value={client}>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-[1.45] text-muted-foreground">
              {STEPS[client].map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
