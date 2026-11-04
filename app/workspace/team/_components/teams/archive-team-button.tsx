"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import type { TeamDoc } from "./teams-data";

/** Archive an active team, or Restore an archived one, with Undo. */
export function ArchiveButton({
  team,
  size = "sm",
  className,
}: {
  team: TeamDoc;
  size?: "xs" | "sm";
  className?: string;
}) {
  const setTeamActive = useMutation(api.attribution.teams.setTeamActive);
  const [saving, setSaving] = useState(false);

  async function set(teamId: Id<"attributionTeams">, isActive: boolean) {
    await setTeamActive({ teamId, isActive });
    posthog.capture("team_active_set", { isActive });
  }

  async function toggle() {
    const next = !team.isActive;
    setSaving(true);
    try {
      await set(team._id, next);
      toast.success(next ? `${team.displayName} restored` : `${team.displayName} archived`, {
        action: {
          label: "Undo",
          onClick: () => {
            set(team._id, !next).catch((error: unknown) => {
              reportClientError(error, { flow: "team_active_undo" });
              toast.error(getErrorMessage(error, "Couldn’t undo that change."));
            });
          },
        },
      });
    } catch (error) {
      reportClientError(error, { flow: "team_active_set" });
      toast.error(getErrorMessage(error, "Couldn’t change this team."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Button
      variant="outline"
      size={size}
      className={className}
      disabled={saving}
      onClick={() => void toggle()}
    >
      {team.isActive ? "Archive" : "Restore"}
    </Button>
  );
}
