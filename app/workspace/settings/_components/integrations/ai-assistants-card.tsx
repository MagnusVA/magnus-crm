"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { FAMILY_LABELS, type WriteFamily } from "@/convex/mcp/families";
import { useRole } from "@/components/auth/role-context";
import { ConnectionUrl } from "@/components/ai-assistants/connection-url";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { CARD, CardHead, LABEL } from "@/app/workspace/team/_components/team-ui";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { IntegrationCardSkeleton } from "../settings-skeleton";
import { Fact, Facts, NoteLine, StatusWord } from "../settings-ui";

const AccessConfirmDialog = dynamic(() => import("@/components/ai-assistants/access-confirm-dialog"));

type AdminRole = "tenant_master" | "tenant_admin";

/** The admin roles, in the order the card lists them. */
const ADMIN_ROWS: { role: AdminRole; label: string }[] = [
  { role: "tenant_master", label: "Owner" },
  { role: "tenant_admin", label: "Admins" },
];

const ROLE_WORD: Record<string, string> = {
  closer: "closers",
  lead_generator: "lead generators",
  tenant_master: "owner",
  tenant_admin: "admins",
};

/**
 * Who may connect an AI app (Claude, ChatGPT, terminal agents) to Magnus
 * over MCP (docs/plans/closer-assistant.md §7, docs/plans/admin-assistant.md §4).
 * One switch per role. Admin roles, and the changes their assistants may
 * make, are the owner's to change. Owners and admins with `settings:manage`.
 */
export function AiAssistantsCard() {
  const { hasPermission } = useRole();
  if (!hasPermission("settings:manage")) return null;
  return <AiAssistantsSettings />;
}

function AiAssistantsSettings() {
  const settings = useQuery(api.mcp.settings.getAiAssistantSettings, {});
  const setRoles = useMutation(api.mcp.settings.setRoles);
  const setWriteAccess = useMutation(api.mcp.settings.setWriteAccess);
  const [confirmOn, setConfirmOn] = useState<null | "closer" | "lead_generator" | AdminRole>(null);
  const [saving, setSaving] = useState(false);

  if (settings === undefined) {
    return <IntegrationCardSkeleton label="Loading AI assistant settings" groups={[3]} />;
  }

  const roles = settings.roles;
  const closersOn = roles.includes("closer");
  const canManageAdmins = settings.canManageAdminAccess;
  const readingAdmins = ADMIN_ROWS.filter(({ role }) => roles.includes(role));
  const onFor = (["closer", "tenant_master", "tenant_admin", "lead_generator"] as const).filter((role) => roles.includes(role));

  async function turnOff(role: "closer" | "lead_generator" | AdminRole) {
    setSaving(true);
    try {
      await setRoles({ roles: roles.filter((r) => r !== role) });
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't turn off AI assistant access."));
    } finally {
      setSaving(false);
    }
  }

  async function saveWrites(writeRoles: AdminRole[], writeFamilies: WriteFamily[], turnedOn: boolean) {
    setSaving(true);
    try {
      await setWriteAccess({ writeRoles, writeFamilies });
      if (turnedOn) toast.success("Saved. Admins reconnect their assistant to see the new tools.");
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't change what assistants can change."));
    } finally {
      setSaving(false);
    }
  }

  const confirmCopy =
    confirmOn === "closer"
      ? {
          title: "Turn on for closers?",
          description:
            "Their AI agents can read their meetings, people and deals, and that data goes to whichever AI provider each closer uses.",
        }
      : confirmOn === "lead_generator"
        ? {
            title: "Turn on for lead generators?",
            description:
              "Their AI agents can save captures, work their respark batch, save contact-again dates and post their end-of-shift report, and that data goes to whichever AI provider each lead generator uses.",
          }
      : confirmOn
        ? {
            title: `Turn on for ${confirmOn === "tenant_master" ? "the owner" : "admins"}?`,
            description:
              "Their AI agents can read the whole workspace: the floor, people, deals, payments and reports. That data goes to whichever AI provider each of them uses. Making changes stays off until you switch it on below.",
          }
        : null;

  return (
    <section aria-label="AI assistants" className={CARD}>
      <CardHead title="AI assistants">
        <StatusWord tone={onFor.length ? "ok" : "muted"}>
          {onFor.length ? `On for ${onFor.map((role) => ROLE_WORD[role]).join(", ")}` : "Off"}
        </StatusWord>
      </CardHead>
      <div className="border-b border-border px-4 py-2.5">
        <NoteLine>
          Your team can connect Claude, ChatGPT or a terminal agent to Magnus. Each agent signs in as its person and
          sees only what they can: closers work their own day; the owner and admins read the whole workspace.
        </NoteLine>
      </div>
      <ul className="border-b border-border last:border-b-0">
        <RoleRow
          id="ai-closers"
          label="Closers"
          description="16 tools · their own meetings, people, deals, payments and recordings"
          checked={closersOn}
          disabled={saving || !settings.availableRoles.includes("closer")}
          onCheckedChange={(on) => {
            if (on) setConfirmOn("closer");
            else void turnOff("closer");
          }}
        />
        {ADMIN_ROWS.map(({ role, label }) => (
          <RoleRow
            key={role}
            id={`ai-${role}`}
            label={label}
            description="Reads the floor, people, deals, payments and reports. Changes only where switched on below."
            checked={roles.includes(role)}
            disabled={saving || !canManageAdmins || !settings.availableRoles.includes(role)}
            onCheckedChange={(on) => {
              if (on) setConfirmOn(role);
              else void turnOff(role);
            }}
          />
        ))}
        <RoleRow
          id="ai-lead-generators"
          label="Lead generators"
          description="12 tools · captures, respark, their own numbers and people, contact-again dates and the end of the shift"
          checked={roles.includes("lead_generator")}
          disabled={saving || !settings.availableRoles.includes("lead_generator")}
          onCheckedChange={(on) => {
            if (on) setConfirmOn("lead_generator");
            else void turnOff("lead_generator");
          }}
        />
      </ul>
      {!canManageAdmins ? (
        <div className="border-b border-border px-4 py-2.5">
          <NoteLine role="status">Only the owner can change admin access.</NoteLine>
        </div>
      ) : null}
      {readingAdmins.length ? (
        <WriteAccess
          readingAdmins={readingAdmins}
          writeRoles={settings.writeRoles}
          writeFamilies={settings.writeFamilies}
          families={settings.families}
          disabled={saving || !canManageAdmins}
          onChange={saveWrites}
        />
      ) : null}
      {onFor.length ? (
        <Facts>
          <Fact
            label="Connection URL"
            tip="Your team pastes this into their AI app's connectors. They also see it, with the setup steps, on their Profile page."
          >
            <ConnectionUrl url={settings.resourceUrl} />
          </Fact>
        </Facts>
      ) : null}
      {confirmOn && confirmCopy ? (
        <AccessConfirmDialog
          title={confirmCopy.title}
          description={confirmCopy.description}
          action="Turn on"
          onClose={() => setConfirmOn(null)}
          onConfirm={() => setRoles({ roles: [...new Set([...roles, confirmOn])] })}
        />
      ) : null}
    </section>
  );
}

/**
 * "Can make changes": which reading admin roles may make changes, and which
 * kinds. The kinds are one list for the workspace, shared by every role
 * ticked here.
 */
function WriteAccess({
  readingAdmins,
  writeRoles,
  writeFamilies,
  families,
  disabled,
  onChange,
}: {
  readingAdmins: typeof ADMIN_ROWS;
  writeRoles: AdminRole[];
  writeFamilies: WriteFamily[];
  families: WriteFamily[];
  disabled: boolean;
  onChange: (writeRoles: AdminRole[], writeFamilies: WriteFamily[], turnedOn: boolean) => void;
}) {
  // A role switched off for reading loses its writes on the server; keep only reading ones.
  const roles = writeRoles.filter((role) => readingAdmins.some((row) => row.role === role));
  const anyRole = roles.length > 0;

  function toggleRole(role: AdminRole, on: boolean) {
    const next = on ? [...new Set([...roles, role])] : roles.filter((r) => r !== role);
    onChange(next, writeFamilies, on && writeFamilies.length > 0);
  }

  function toggleFamily(family: WriteFamily, on: boolean) {
    const next = on ? [...new Set([...writeFamilies, family])] : writeFamilies.filter((f) => f !== family);
    onChange(roles, next, on && anyRole);
  }

  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
      <div className="flex flex-col gap-1">
        <h3 className={LABEL}>Can make changes</h3>
        <NoteLine>
          Every change is previewed first: the assistant shows what it will do, and nothing is written until it&apos;s
          confirmed.
        </NoteLine>
      </div>

      <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
        <legend className="mb-1 text-[13px] text-muted-foreground">Whose assistants</legend>
        {readingAdmins.map(({ role, label }) => (
          <CheckRow
            key={role}
            id={`ai-write-${role}`}
            label={label}
            checked={roles.includes(role)}
            disabled={disabled}
            onCheckedChange={(on) => toggleRole(role, on)}
          />
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
        <legend className="mb-1 text-[13px] text-muted-foreground">
          Kinds of change, for every role ticked above
        </legend>
        <div className="grid gap-1.5 @lg:grid-cols-2">
          {families.map((family) => (
            <CheckRow
              key={family}
              id={`ai-family-${family}`}
              label={FAMILY_LABELS[family] ?? family}
              checked={writeFamilies.includes(family)}
              disabled={disabled}
              onCheckedChange={(on) => toggleFamily(family, on)}
            />
          ))}
        </div>
      </fieldset>

      <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-[1.45] text-muted-foreground">
        <li>&ldquo;Always allow&rdquo; in an AI app covers every kind of change switched on here.</li>
        <li>Payment reviews, covering a closer and losses are approved in Magnus, never in chat.</li>
        <li>After a kind of change is switched on, an admin reconnects their assistant to see the new tools.</li>
      </ul>
    </div>
  );
}

function CheckRow({
  id,
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <label htmlFor={id} className={cn("text-sm", disabled && "text-muted-foreground")}>
        {label}
      </label>
    </div>
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
