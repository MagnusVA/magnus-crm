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
import { IntegrationCardSkeleton } from "../settings-skeleton";
import { Fact, Facts, NoteLine, StatusWord } from "../settings-ui";

const AccessConfirmDialog = dynamic(() => import("@/components/ai-assistants/access-confirm-dialog"));

type Role = "tenant_master" | "tenant_admin" | "closer" | "lead_generator";

/**
 * One switch per group of roles with a toolset. Owners and admins share the
 * admin toolset, so they share a switch.
 */
const GROUPS: readonly {
  id: string;
  label: string;
  /** The group in a sentence: "On for closers". */
  noun: string;
  roles: readonly Role[];
  description: string;
  confirm: string;
}[] = [
  {
    id: "ai-closers",
    label: "Closers",
    noun: "closers",
    roles: ["closer"],
    description: "16 tools · their own meetings, people, deals, payments and recordings",
    confirm:
      "Their AI agents can read their meetings, people and deals, and that data goes to whichever AI provider each closer uses.",
  },
  {
    id: "ai-lead-generators",
    label: "Lead generators",
    noun: "lead generators",
    roles: ["lead_generator"],
    description: "12 tools · captures, respark, their own numbers and people, contact-again dates and the end of the shift",
    confirm:
      "Their AI agents can save captures, work their respark batch, save contact-again dates and post their end-of-shift report, and that data goes to whichever AI provider each lead generator uses.",
  },
  {
    id: "ai-admins",
    label: "Owners and admins",
    noun: "admins",
    roles: ["tenant_master", "tenant_admin"],
    description: "6 tools · the lead gen report, today's floor, the roster, raw submissions and voiding a capture",
    confirm:
      "Their AI agents can read the lead gen report, every specialist's numbers and raw submissions, and void a capture. That data goes to whichever AI provider each admin uses.",
  },
];

type Group = (typeof GROUPS)[number];

/** "closers", "closers and admins", "closers, lead generators and admins". */
function sentenceList(words: string[]) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * Who may connect an AI app (Claude, ChatGPT, terminal agents) to Magnus
 * over MCP (docs/plans/closer-assistant.md §7, docs/plans/lead-gen-assistant.md
 * §4). One switch per group of roles. Owners and admins with `settings:manage`.
 */
export function AiAssistantsCard() {
  const { hasPermission } = useRole();
  if (!hasPermission("settings:manage")) return null;
  return <AiAssistantsSettings />;
}

function AiAssistantsSettings() {
  const settings = useQuery(api.mcp.settings.getAiAssistantSettings, {});
  const setRoles = useMutation(api.mcp.settings.setRoles);
  const [confirmOn, setConfirmOn] = useState<Group | null>(null);
  const [saving, setSaving] = useState(false);

  if (settings === undefined) {
    return <IntegrationCardSkeleton label="Loading AI assistant settings" groups={[3]} />;
  }

  // On when any of the group's roles is on: one admin role saved alone still
  // lets those admins connect, so the card must not call the group off.
  const isOn = (group: Group) => group.roles.some((role) => settings.roles.includes(role));
  const isPartial = (group: Group) => isOn(group) && !group.roles.every((role) => settings.roles.includes(role));
  const on = GROUPS.filter(isOn);

  async function turnOff(group: Group) {
    setSaving(true);
    try {
      await setRoles({ roles: (settings?.roles ?? []).filter((role) => !group.roles.includes(role)) });
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't turn off AI assistant access."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="AI assistants" className={CARD}>
      <CardHead title="AI assistants">
        <StatusWord tone={on.length > 0 ? "ok" : "muted"}>
          {on.length > 0 ? `On for ${sentenceList(on.map((group) => group.noun))}` : "Off"}
        </StatusWord>
      </CardHead>
      <div className="border-b border-border px-4 py-2.5">
        <NoteLine>
          People in the roles you turn on can connect Claude, ChatGPT or a terminal agent to Magnus and work through
          it. Each agent signs in as its person and sees only what they can.
        </NoteLine>
      </div>
      <ul className="border-b border-border last:border-b-0">
        {GROUPS.map((group) => (
          <RoleRow
            key={group.id}
            id={group.id}
            label={group.label}
            description={
              isPartial(group)
                ? `${group.description} · on for part of this group; turn it off and on to include everyone`
                : group.description
            }
            checked={isOn(group)}
            disabled={saving || !group.roles.every((role) => settings.availableRoles.includes(role))}
            onCheckedChange={(checked) => {
              if (checked) setConfirmOn(group);
              else void turnOff(group);
            }}
          />
        ))}
      </ul>
      {on.length > 0 ? (
        <Facts>
          <Fact
            label="Connection URL"
            tip="People paste this into their AI app's connectors. They also see it, with the setup steps, on their Profile page."
          >
            <ConnectionUrl url={settings.resourceUrl} />
          </Fact>
        </Facts>
      ) : null}
      {confirmOn ? (
        <AccessConfirmDialog
          title={`Turn on for ${confirmOn.noun}?`}
          description={confirmOn.confirm}
          action="Turn on"
          onClose={() => setConfirmOn(null)}
          onConfirm={() => setRoles({ roles: [...new Set([...settings.roles, ...confirmOn.roles])] })}
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
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <li className="flex min-h-11 items-center gap-3 border-b border-border px-4 py-1.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
        <p className="text-[13px] leading-[1.45] text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </li>
  );
}
