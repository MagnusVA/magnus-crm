"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConnectionUrl } from "@/components/ai-assistants/connection-url";

export function ConnectAiAssistantCard() {
  const access = useQuery(api.mcp.settings.getMyAiAssistantAccess);
  if (!access?.roleEnabled) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect your AI assistant</CardTitle>
        <CardDescription>
          Paste this URL into your AI app&apos;s connectors, then sign in with
          your Magnus login.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {access.blocked ? (
          <Alert>
            <AlertDescription>
              Your AI assistant access is blocked. Ask an admin.
            </AlertDescription>
          </Alert>
        ) : null}
        <ConnectionUrl url={access.resourceUrl} />
        <Tabs defaultValue="claude">
          <TabsList className="max-w-full">
            <TabsTrigger value="claude">Claude</TabsTrigger>
            <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
            <TabsTrigger value="terminal">Terminal agents</TabsTrigger>
          </TabsList>
          <TabsContent value="claude">
            <Steps
              steps={[
                "Open Claude's connector settings and add a custom connector named Magnus.",
                "Paste the connection URL, connect, and sign in with your Magnus login.",
                'Ask "What is on my day in Magnus?"',
              ]}
            />
          </TabsContent>
          <TabsContent value="chatgpt">
            <Steps
              steps={[
                "Open ChatGPT's app settings and enable developer mode if needed to create a custom app.",
                "Create an app named Magnus using the connection URL and OAuth, then sign in with your Magnus login.",
                "Select Magnus in a chat and ask for your day.",
              ]}
            />
          </TabsContent>
          <TabsContent value="terminal">
            <Steps
              steps={[
                "In Claude Code, Hermes or another MCP-capable agent, add an HTTP MCP server named magnus.",
                "Use the connection URL as the server URL, then complete its OAuth sign-in with your Magnus login.",
                "Ask the agent to call magnus_today.",
              ]}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}
