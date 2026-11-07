"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { ConnectionUrl } from "@/components/ai-assistants/connection-url";
import { Switch } from "@/components/ui/switch";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { IntegrationCardSkeleton } from "../settings-skeleton";
import { Fact, Facts, NoteLine, StatusWord } from "../settings-ui";

const AccessConfirmDialog = dynamic(() => import("@/components/ai-assistants/access-confirm-dialog"));

/** Roles with no tools yet: shown, switched off. */
const NO_TOOLS = ["Admins", "Lead generators"] as const;

/**
 * Who may connect an AI app (Claude, ChatGPT, terminal agents) to Magnus
 * over MCP (docs/plans/closer-assistant.md §7). One switch per role; only
 * closers have tools. Owners and admins with `settings:manage`.
 */
export function AiAssistantsCard() {
  const { hasPermission } = useRole();
  if (!hasPermission("settings:manage")) return null;
  return <AiAssistantsSettings />;
}

function AiAssistantsSettings() {
  const settings = useQuery(api.mcp.settings.getAiAssistantSettings, {});
  const setRoles = useMutation(api.mcp.settings.setRoles);
  const [confirmOn, setConfirmOn] = useState(false);
  const [saving, setSaving] = useState(false);

  if (settings === undefined) {
    return <IntegrationCardSkeleton label="Loading AI assistant settings" groups={[3]} />;
  }

  const enabled = settings.roles.includes("closer");

  async function turnOff() {
    setSaving(true);
    try {
      await setRoles({ roles: (settings?.roles ?? []).filter((role) => role !== "closer") });
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't turn off AI assistant access."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="AI assistants" className={CARD}>
      <CardHead title="AI assistants">
        <StatusWord tone={enabled ? "ok" : "muted"}>{enabled ? "On for closers" : "Off"}</StatusWord>
      </CardHead>
      <div className="border-b border-border px-4 py-2.5">
        <NoteLine>
          Closers can connect Claude, ChatGPT or a terminal agent to Magnus and work their own day through it. Each
          agent signs in as its closer and sees only what they can.
        </NoteLine>
      </div>
      <ul className="border-b border-border last:border-b-0">
        <RoleRow
          id="ai-closers"
          label="Closers"
          description="16 tools · their own meetings, people, deals, payments and recordings"
          checked={enabled}
          disabled={saving || !settings.availableRoles.includes("closer")}
          onCheckedChange={(on) => {
            if (on) setConfirmOn(true);
            else void turnOff();
          }}
        />
        {NO_TOOLS.map((label) => (
          <RoleRow key={label} id={`ai-${label}`} label={label} description="No tools yet" checked={false} disabled />
        ))}
      </ul>
      {enabled ? (
        <Facts>
          <Fact
            label="Connection URL"
            tip="Closers paste this into their AI app's connectors. They also see it, with the setup steps, on their Profile page."
          >
            <ConnectionUrl url={settings.resourceUrl} />
          </Fact>
        </Facts>
      ) : null}
      {confirmOn ? (
        <AccessConfirmDialog
          title="Turn on for closers?"
          description="Their AI agents can read their meetings, people and deals, and that data goes to whichever AI provider each closer uses."
          action="Turn on"
          onClose={() => setConfirmOn(false)}
          onConfirm={() => setRoles({ roles: [...new Set([...settings.roles, "closer" as const])] })}
        />
      ) : null}
    </section>
  );
}

/** One role: its name and what its agents can do, then the switch. */
function RoleRow({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const inert = !onCheckedChange;
  return (
    <li className="flex min-h-11 items-center gap-3 border-b border-border px-4 py-1.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className={cn("block text-sm font-medium", inert && "text-muted-foreground")}>
          {label}
        </label>
        <p className="text-[13px] leading-[1.45] text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </li>
  );
}
