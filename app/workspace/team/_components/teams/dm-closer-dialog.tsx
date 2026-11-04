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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { MemberIdentityOption } from "@/app/workspace/_components/member-identity";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { getErrorMessage } from "@/lib/errors";

type DmCloserRow = Doc<"dmClosers"> & { teamLabel: string };
type TeamMemberOption = {
  _id: Id<"users">;
  fullName?: string;
  email: string;
  role: Doc<"users">["role"];
  isActive: boolean;
  avatar: MemberAvatarIdentity;
};

export function DmCloserDialog({
  open,
  onOpenChange,
  dmCloser,
  teams,
  teamMembers,
  defaults,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dmCloser?: DmCloserRow;
  teams: Doc<"attributionTeams">[];
  teamMembers: TeamMemberOption[];
  /** Prefills a new DM closer (the team page's team, an unmatched utm_medium). */
  defaults?: { teamId?: Id<"attributionTeams">; utmMedium?: string; displayName?: string };
  /** Called with the DM closer's id after a save, before the dialog closes. */
  onSaved?: (dmCloserId: Id<"dmClosers">) => void;
}) {
  const [teamId, setTeamId] = useState<Id<"attributionTeams"> | undefined>();
  const [linkedUserId, setLinkedUserId] = useState<Id<"users"> | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [utmMedium, setUtmMedium] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const createDmCloser = useMutation(api.attribution.dmClosers.createDmCloser);
  const updateDmCloser = useMutation(api.attribution.dmClosers.updateDmCloser);

  // Load the fields each time the dialog opens or targets another DM closer.
  const sessionKey = open ? (dmCloser?._id ?? "new") : null;
  const [loadedSessionKey, setLoadedSessionKey] = useState<string | null>(null);
  if (sessionKey !== loadedSessionKey) {
    setLoadedSessionKey(sessionKey);
    if (open) {
      setTeamId(dmCloser?.teamId ?? defaults?.teamId ?? (teams.find((team) => team.isActive) ?? teams[0])?._id);
      setLinkedUserId(dmCloser?.userId ?? null);
      setDisplayName(dmCloser?.displayName ?? defaults?.displayName ?? "");
      setUtmMedium(dmCloser?.utmMedium ?? defaults?.utmMedium ?? "");
    }
  }

  async function handleSave() {
    if (!teamId) {
      toast.error("Select a DM team first");
      return;
    }
    setIsSaving(true);
    try {
      const dmCloserId = dmCloser
        ? await updateDmCloser({
            dmCloserId: dmCloser._id,
            teamId,
            displayName,
            utmMedium,
            userId: linkedUserId,
          })
        : await createDmCloser({
            teamId,
            displayName,
            utmMedium,
            userId: linkedUserId,
          });
      toast.success(dmCloser ? `${displayName.trim()} saved` : `${displayName.trim()} added`);
      onSaved?.(dmCloserId);
      onOpenChange(false);
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Unable to save DM closer"),
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {dmCloser ? "Edit DM closer" : "New DM closer"}
          </DialogTitle>
          <DialogDescription>
            A DM closer is one utm_medium on a DM team. They pick their name in
            the link portal; they don’t get a CRM account.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="dm-closer-team">DM team</FieldLabel>
            <Select
              value={teamId}
              onValueChange={(value) =>
                setTeamId(value as Id<"attributionTeams">)
              }
              disabled={isSaving}
            >
              <SelectTrigger id="dm-closer-team">
                <SelectValue placeholder="Select team" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {teams.map((team) => (
                    <SelectItem key={team._id} value={team._id}>
                      {team.displayName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="dm-closer-display-name">Name</FieldLabel>
            <Input
              id="dm-closer-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={isSaving}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="dm-closer-utm-medium">utm_medium</FieldLabel>
            <Input
              id="dm-closer-utm-medium"
              value={utmMedium}
              onChange={(event) => setUtmMedium(event.target.value)}
              disabled={isSaving}
              className="font-mono"
              spellCheck={false}
              autoCapitalize="none"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="dm-closer-linked-user">Linked CRM user</FieldLabel>
            <Select
              value={linkedUserId ?? "__none__"}
              onValueChange={(value) =>
                setLinkedUserId(
                  value === "__none__" ? null : (value as Id<"users">),
                )
              }
              disabled={isSaving}
            >
              <SelectTrigger id="dm-closer-linked-user">
                <SelectValue placeholder="No linked user" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>CRM user</SelectLabel>
                  <SelectItem value="__none__">No linked user</SelectItem>
                  {teamMembers.map((member) => (
                    <SelectItem key={member._id} value={member._id}>
                      <MemberIdentityOption identity={member.avatar} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
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
