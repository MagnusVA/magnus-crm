"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

export function AttributionTeamDialog({
  open,
  onOpenChange,
  team,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team?: Doc<"attributionTeams">;
}) {
  const [displayName, setDisplayName] = useState("");
  const [utmSource, setUtmSource] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const createTeam = useMutation(api.attribution.teams.createTeam);
  const updateTeam = useMutation(api.attribution.teams.updateTeam);

  useEffect(() => {
    if (open) {
      setDisplayName(team?.displayName ?? "");
      setUtmSource(team?.utmSource ?? "");
    }
  }, [open, team]);

  async function handleSave() {
    setIsSaving(true);
    try {
      if (team) {
        await updateTeam({ teamId: team._id, displayName, utmSource });
      } else {
        await createTeam({ displayName, utmSource });
      }
      toast.success(team ? "Attribution team updated" : "Attribution team created");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save team");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{team ? "Edit DM Team" : "New DM Team"}</DialogTitle>
          <DialogDescription>
            Map a canonical UTM source to an external DM team.
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
            <FieldLabel htmlFor="team-utm-source">UTM Source</FieldLabel>
            <Input
              id="team-utm-source"
              value={utmSource}
              onChange={(event) => setUtmSource(event.target.value)}
              disabled={isSaving}
            />
          </Field>
        </FieldGroup>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Spinner data-icon="inline-start" />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
