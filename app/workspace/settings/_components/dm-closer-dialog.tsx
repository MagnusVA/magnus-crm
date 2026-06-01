"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dmCloser?: DmCloserRow;
  teams: Doc<"attributionTeams">[];
  teamMembers: TeamMemberOption[];
}) {
  const [teamId, setTeamId] = useState<Id<"attributionTeams"> | undefined>();
  const [linkedUserId, setLinkedUserId] = useState<Id<"users"> | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [utmMedium, setUtmMedium] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const createDmCloser = useMutation(api.attribution.dmClosers.createDmCloser);
  const updateDmCloser = useMutation(api.attribution.dmClosers.updateDmCloser);

  useEffect(() => {
    if (open) {
      setTeamId(dmCloser?.teamId ?? teams[0]?._id);
      setLinkedUserId(dmCloser?.userId ?? null);
      setDisplayName(dmCloser?.displayName ?? "");
      setUtmMedium(dmCloser?.utmMedium ?? "");
    }
  }, [dmCloser, open, teams]);

  async function handleSave() {
    if (!teamId) {
      toast.error("Select a DM team first");
      return;
    }
    setIsSaving(true);
    try {
      if (dmCloser) {
        await updateDmCloser({
          dmCloserId: dmCloser._id,
          teamId,
          displayName,
          utmMedium,
          userId: linkedUserId,
        });
      } else {
        await createDmCloser({
          teamId,
          displayName,
          utmMedium,
          userId: linkedUserId,
        });
      }
      toast.success(dmCloser ? "DM closer updated" : "DM closer created");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to save DM closer",
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
            {dmCloser ? "Edit DM Closer" : "New DM Closer"}
          </DialogTitle>
          <DialogDescription>
            DM closers are attribution records and can optionally link to a CRM
            user for workspace avatar display.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>DM Team</FieldLabel>
            <Select
              value={teamId}
              onValueChange={(value) =>
                setTeamId(value as Id<"attributionTeams">)
              }
              disabled={isSaving}
            >
              <SelectTrigger>
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
            <FieldLabel htmlFor="dm-closer-utm-medium">UTM Medium</FieldLabel>
            <Input
              id="dm-closer-utm-medium"
              value={utmMedium}
              onChange={(event) => setUtmMedium(event.target.value)}
              disabled={isSaving}
            />
          </Field>
          <Field>
            <FieldLabel>Linked CRM user</FieldLabel>
            <Select
              value={linkedUserId ?? "__none__"}
              onValueChange={(value) =>
                setLinkedUserId(
                  value === "__none__" ? null : (value as Id<"users">),
                )
              }
              disabled={isSaving}
            >
              <SelectTrigger>
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
