"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { CrmRole } from "@/convex/lib/roleMapping";
import { useRole } from "@/components/auth/role-context";
import { ConnectionUrl } from "@/components/ai-assistants/connection-url";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { Fact, Facts, NoteLine, StatusWord } from "@/app/workspace/settings/_components/settings-ui";

/** What to ask first, and the tool that answers it, for each role's toolset. */
function firstAsk(role: CrmRole) {
  if (role === "lead_generator") {
    return { question: "What does my lead gen shift look like in Magnus?", short: "your shift", tool: "magnus_lead_gen_today" };
  }
  if (role === "closer") {
    return { question: "What is on my day in Magnus?", short: "your day", tool: "magnus_today" };
  }
  return { question: "How is lead gen doing today in Magnus?", short: "today's lead gen floor", tool: "magnus_lead_gen_floor" };
}

function stepsFor(role: CrmRole) {
  const ask = firstAsk(role);
  return {
    claude: [
      "Open Claude's connector settings and add a custom connector named Magnus.",
      "Paste the connection URL, connect, and sign in with your Magnus login.",
      `Ask "${ask.question}"`,
    ],
    chatgpt: [
      "Open ChatGPT's app settings and enable developer mode if needed to create a custom app.",
      "Create an app named Magnus using the connection URL and OAuth, then sign in with your Magnus login.",
      `Select Magnus in a chat and ask for ${ask.short}.`,
    ],
    terminal: [
      "In Claude Code, Hermes or another MCP-capable agent, add an HTTP MCP server named magnus.",
      "Use the connection URL as the server URL, then complete its OAuth sign-in with your Magnus login.",
      `Ask the agent to call ${ask.tool}.`,
    ],
  } as const;
}

/**
 * The person's connection URL and setup steps, while AI assistants are on for
 * their role (docs/plans/closer-assistant.md §7). A blocked person sees why.
 */
export function ConnectAiAssistantCard() {
  const access = useQuery(api.mcp.settings.getMyAiAssistantAccess);
  const { role } = useRole();
  if (!access?.roleEnabled) return null;
  const steps = stepsFor(role);
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
        {(Object.keys(steps) as (keyof typeof steps)[]).map((client) => (
          <TabsContent key={client} value={client}>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-[1.45] text-muted-foreground">
              {steps[client].map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
