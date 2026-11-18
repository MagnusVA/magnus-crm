"use client";

import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { hasPermission } from "@/convex/lib/permissions";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { NoteLine, SettingRow } from "@/app/workspace/settings/_components/settings-ui";
import { getErrorMessage } from "@/lib/errors";
import type { AutomationSettingsView } from "./automation-kinds";

/** Who grades: one active owner or admin. Only the owner can change it. */
export function GraderCard({ view }: { view: AutomationSettingsView }) {
  const id = useId();
  const members = useQuery(api.users.queries.listTeamMembers, {});
  const setGrader = useMutation(api.automation.settings.setGrader);
  const [saving, setSaving] = useState(false);
  const graderId = view.configured?.graderUserId;

  const graders = (members ?? []).filter(
    (member) =>
      member.isActive !== false &&
      !member.isPendingInvite &&
      hasPermission(member.role, "result-automation:grade"),
  );
  const current = members?.find((member) => member._id === graderId);
  const nameOf = (member: { fullName?: string; email: string }) => member.fullName?.trim() || member.email;

  const save = async (userId: Id<"users">) => {
    setSaving(true);
    try {
      await setGrader({ userId });
      toast.success("The grader is saved.");
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't save the grader."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className={`${CARD} @container`}>
      <CardHead
        title={<span id={`${id}-title`}>Grader</span>}
        meta="A payment case takes about two minutes, a call about twelve."
      />
      {view.canRaise ? (
        <SettingRow
          label="Who grades"
          htmlFor={`${id}-grader`}
          description="An owner or admin who checks the system's decisions against the evidence."
        >
          <div className="flex items-center gap-2">
            <Select
              value={graderId ?? ""}
              disabled={saving || members === undefined}
              onValueChange={(value) => void save(value as Id<"users">)}
            >
              <SelectTrigger id={`${id}-grader`} className="w-64 max-w-full">
                <SelectValue placeholder={members === undefined ? "Loading the team…" : "Choose an owner or admin"} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {graders.map((member) => (
                    <SelectItem key={member._id} value={member._id}>
                      {nameOf(member)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {saving ? <Spinner className="size-4 text-muted-foreground" aria-label="Saving" /> : null}
          </div>
        </SettingRow>
      ) : (
        <div className="flex flex-col gap-1 px-4 py-3">
          <p className="text-sm">
            {graderId === undefined
              ? "No one is named yet."
              : members === undefined
                ? "Loading…"
                : current
                  ? nameOf(current)
                  : "Someone no longer on the team."}
          </p>
          <NoteLine>Only the owner can name the grader.</NoteLine>
        </div>
      )}
    </section>
  );
}
