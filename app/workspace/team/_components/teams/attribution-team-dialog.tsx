"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { HelpTip } from "../team-ui";

// Mirrors MAX_BOOKING_DAILY_QUOTA in convex/attribution/teams.ts.
const MAX_DAILY_GOAL = 5000;

export function AttributionTeamDialog({
  open,
  onOpenChange,
  team,
  defaults,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team?: Doc<"attributionTeams">;
  /** Prefills a new team (an unmatched utm_source, say). */
  defaults?: { displayName?: string; utmSource?: string };
  /** Called with the team's id after a save, before the dialog closes. */
  onSaved?: (teamId: Id<"attributionTeams">) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [utmSource, setUtmSource] = useState("");
  const [goal, setGoal] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const createTeam = useMutation(api.attribution.teams.createTeam);
  const updateTeam = useMutation(api.attribution.teams.updateTeam);
  const setQuota = useMutation(api.attribution.teams.setTeamBookingQuota);

  // Load the fields each time the dialog opens or targets another team.
  const sessionKey = open ? (team?._id ?? "new") : null;
  const [loadedSessionKey, setLoadedSessionKey] = useState<string | null>(null);
  if (sessionKey !== loadedSessionKey) {
    setLoadedSessionKey(sessionKey);
    if (open) {
      setDisplayName(team?.displayName ?? defaults?.displayName ?? "");
      setUtmSource(team?.utmSource ?? defaults?.utmSource ?? "");
      setGoal(team?.bookingDailyQuota === undefined ? "" : String(team.bookingDailyQuota));
    }
  }

  const goalText = goal.trim();
  const goalValue = goalText === "" ? null : Number(goalText);
  const goalInvalid =
    goalValue !== null && (!Number.isInteger(goalValue) || goalValue < 0 || goalValue > MAX_DAILY_GOAL);

  async function handleSave() {
    if (goalInvalid) return;
    setIsSaving(true);
    try {
      const teamId = team
        ? await updateTeam({ teamId: team._id, displayName, utmSource })
        : await createTeam({ displayName, utmSource });
      if (goalValue !== (team?.bookingDailyQuota ?? null)) {
        await setQuota({ teamId, bookingDailyQuota: goalValue });
      }
      toast.success(team ? `${displayName.trim()} saved` : `${displayName.trim()} created`);
      onSaved?.(teamId);
      onOpenChange(false);
    } catch (error) {
      reportClientError(error, { flow: team ? "team_update" : "team_create" });
      toast.error(getErrorMessage(error, "Couldn’t save the team."));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{team ? "Edit team" : "New team"}</DialogTitle>
          <DialogDescription>
            It shows up on Lead Gen, Booked Calls and Coverage. Its DM
            closers’ links carry its utm_source.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="team-display-name">Name</FieldLabel>
            <Input
              id="team-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={isSaving}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="team-utm-source">
              <HelpTip tip="What its DM links carry as utm_source. Bookings with it credit this team. Lowercase, no spaces.">
                utm_source
              </HelpTip>
            </FieldLabel>
            <Input
              id="team-utm-source"
              value={utmSource}
              onChange={(event) => setUtmSource(event.target.value)}
              disabled={isSaving}
              className="font-mono"
              spellCheck={false}
              autoCapitalize="none"
            />
          </Field>
          <Field data-invalid={goalInvalid || undefined} className="max-w-56">
            <FieldLabel htmlFor="team-booked-goal">
              <HelpTip tip="Optional. Booked calls the team should make each business day. Booked Calls draws the team’s goal ring from it.">
                Booked goal a day
              </HelpTip>
            </FieldLabel>
            <Input
              id="team-booked-goal"
              value={goal}
              inputMode="numeric"
              placeholder="No goal"
              aria-invalid={goalInvalid || undefined}
              onChange={(event) => setGoal(event.target.value)}
              disabled={isSaving}
              className="font-condensed text-[15px] tabular-nums"
            />
            {goalInvalid ? (
              <p className="text-[12.5px] text-danger-ink">A whole number from 0 to {MAX_DAILY_GOAL}, or blank for no goal.</p>
            ) : null}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={isSaving || goalInvalid}>
            {isSaving && <Spinner data-icon="inline-start" />}
            {team ? "Save" : "Create team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
