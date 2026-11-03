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
  const [isSaving, setIsSaving] = useState(false);
  const createTeam = useMutation(api.attribution.teams.createTeam);
  const updateTeam = useMutation(api.attribution.teams.updateTeam);

  // Load the fields each time the dialog opens or targets another team.
  const sessionKey = open ? (team?._id ?? "new") : null;
  const [loadedSessionKey, setLoadedSessionKey] = useState<string | null>(null);
  if (sessionKey !== loadedSessionKey) {
    setLoadedSessionKey(sessionKey);
    if (open) {
      setDisplayName(team?.displayName ?? defaults?.displayName ?? "");
      setUtmSource(team?.utmSource ?? defaults?.utmSource ?? "");
    }
  }

  async function handleSave() {
    setIsSaving(true);
    try {
      const teamId = team
        ? await updateTeam({ teamId: team._id, displayName, utmSource })
        : await createTeam({ displayName, utmSource });
      toast.success(team ? `${displayName.trim()} saved` : `${displayName.trim()} created`);
      onSaved?.(teamId);
      onOpenChange(false);
    } catch (error) {
      toast.error(getErrorMessage(error, "Unable to save team"));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{team ? "Edit DM team" : "New DM team"}</DialogTitle>
          <DialogDescription>
            A DM team is one utm_source. Its DM closers’ links carry it, and
            bookings with it count for the team.
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
            <FieldLabel htmlFor="team-utm-source">utm_source</FieldLabel>
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
          <Button type="button" onClick={handleSave} disabled={isSaving}>
            {isSaving && <Spinner data-icon="inline-start" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
