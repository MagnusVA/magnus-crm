"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { RequirePermission } from "@/components/auth/require-permission";
import { useRole } from "@/components/auth/role-context";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ConnectionUrl } from "@/components/ai-assistants/connection-url";
import { getErrorMessage } from "@/lib/errors";
import { Skeleton } from "@/components/ui/skeleton";

const AccessConfirmDialog = dynamic(
  () => import("@/components/ai-assistants/access-confirm-dialog"),
);
export function AiAssistantsCard() {
  return (
    <RequirePermission permission="settings:manage">
      <AiAssistantsSettings />
    </RequirePermission>
  );
}
function AiAssistantsSettings() {
  const { role } = useRole();
  const settings = useQuery(
    api.mcp.settings.getAiAssistantSettings,
    role === "tenant_master" || role === "tenant_admin" ? {} : "skip",
  );
  const setRoles = useMutation(api.mcp.settings.setRoles);
  const [confirmOn, setConfirmOn] = useState(false);
  const [saving, setSaving] = useState(false);
  const enabled = settings?.roles.includes("closer") ?? false;
  async function turnOff() {
    setSaving(true);
    try {
      await setRoles({
        roles: (settings?.roles ?? []).filter((role) => role !== "closer"),
      });
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Couldn't turn off AI assistant access."),
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI assistants</CardTitle>
        <CardDescription>
          Choose who can connect their AI apps to Magnus.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {settings === undefined ? (
          <Skeleton className="h-16" />
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <div>
                <label htmlFor="ai-closers" className="text-sm font-medium">
                  Closers
                </label>
                <p className="text-sm text-muted-foreground">
                  14 tools · their own meetings, people, deals and payments
                </p>
              </div>
              <Switch
                id="ai-closers"
                checked={enabled}
                disabled={saving || !settings.availableRoles.includes("closer")}
                onCheckedChange={(on) => {
                  if (on) setConfirmOn(true);
                  else void turnOff();
                }}
              />
            </div>
            {["Admins", "Lead generators"].map((label) => (
              <div
                key={label}
                className="flex items-center justify-between gap-4"
              >
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-sm text-muted-foreground">No tools yet</p>
                </div>
                <Switch
                  disabled
                  checked={false}
                  aria-label={`${label}: no tools yet`}
                />
              </div>
            ))}
            {enabled ? (
              <>
                <ConnectionUrl url={settings.resourceUrl} />
                <p className="text-sm text-muted-foreground">
                  Closers also see this URL and the setup steps on their Profile
                  page.
                </p>
              </>
            ) : null}
          </>
        )}
      </CardContent>
      {confirmOn ? (
        <AccessConfirmDialog
          title="Turn on for closers?"
          description="Their AI agents can read their meetings, people and deals, and that data goes to whichever AI provider each closer uses."
          action="Turn on"
          onClose={() => setConfirmOn(false)}
          onConfirm={() =>
            setRoles({
              roles: [
                ...new Set([...(settings?.roles ?? []), "closer" as const]),
              ],
            })
          }
        />
      ) : null}
    </Card>
  );
}
