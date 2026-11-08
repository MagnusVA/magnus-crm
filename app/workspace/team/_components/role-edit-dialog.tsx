"use client";

import { useState, useEffect, useId } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { toast } from "sonner";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  FormRow,
  FormRows,
  SubmitButton,
} from "@/app/workspace/_components/action-dialog";
import { firstName } from "./team-ui";
import { CRM_ROLES, RoleChoices, roleLabel, type CrmRole } from "./team-dialog-parts";

const roleEditSchema = z.object({
  role: z.enum(["closer", "tenant_admin", "lead_generator"]),
});

type RoleEditFormValues = z.infer<typeof roleEditSchema>;

interface RoleEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: Id<"users">;
  userName: string;
  /** Kept for callers; the title names the person. */
  userIdentity?: MemberAvatarIdentity;
  currentRole: string;
  onSuccess?: () => void;
}

/** What the chosen role changes beyond access (convex/workos/userMutations.ts `updateRole`). */
function roleChangeNote(first: string, currentRole: string, nextRole: string) {
  if (nextRole === currentRole) return undefined;
  if (currentRole === "closer") {
    return `Moving ${first} off Closer unlinks the Calendly member and clears the personal event type.`;
  }
  if (nextRole === "closer") {
    return `Closers need a linked Calendly member. Link one for ${first} after this.`;
  }
  return undefined;
}

export function RoleEditDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentRole,
  onSuccess,
}: RoleEditDialogProps) {
  const ids = useId();
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const updateRole = useAction(api.workos.userManagement.updateUserRole);
  const linkCalendly = useMutation(api.users.linkCalendlyMember.linkCloserToCalendlyMember);
  const assignEventType = useMutation(api.users.assignPersonalEventType.assignPersonalEventType);

  const form = useForm({
    resolver: standardSchemaResolver(roleEditSchema),
    defaultValues: {
      role: currentRole as CrmRole,
    },
  });

  // Watch the role field for no-op detection (save button disable)
  const watchedRole = useWatch({ control: form.control, name: "role" });

  // Reset form when dialog opens (currentRole may have changed between opens)
  useEffect(() => {
    if (open) {
      form.reset({ role: currentRole as CrmRole });
    }
  }, [open, currentRole, form]);

  const onSubmit = async (values: RoleEditFormValues) => {
    // No-op guard: if the selected role matches the current role, just close
    if (values.role === currentRole) {
      onOpenChange(false);
      return;
    }

    setIsSaving(true);
    try {
      const { previous } = await updateRole({ userId, newRole: values.role });
      const previousRole = CRM_ROLES.find((option) => option.value === previous.role);
      // Undo puts back the role and what a change away from closer cleared:
      // the Calendly member link and the personal event type.
      const undo = async () => {
        if (!previousRole) return;
        try {
          await updateRole({ userId, newRole: previousRole.value });
          if (previous.calendlyMemberId) {
            await linkCalendly({ userId, calendlyMemberId: previous.calendlyMemberId });
          }
          if (previous.personalEventTypeUri) {
            await assignEventType({ userId, personalEventTypeUri: previous.personalEventTypeUri });
          }
          toast.success(`${userName} is ${previousRole.label} again`);
          router.refresh();
        } catch (error) {
          reportClientError(error, { flow: "team_role_change_undo" });
          toast.error(getErrorMessage(error, "Couldn’t undo the role change."));
        }
      };
      toast.success(
        `${userName}'s role updated to ${roleLabel(values.role)}`,
        previousRole ? { action: { label: "Undo", onClick: () => void undo() } } : undefined,
      );
      onOpenChange(false);
      onSuccess?.();
      // Re-run server components so getWorkspaceAccess() picks up fresh CRM data
      router.refresh();
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Failed to update role"),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const first = firstName(userName);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isSaving) onOpenChange(next);
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSaving}>
        <ActionDialogHeader
          title={`Change ${userName}'s role`}
          description={`The new role applies from ${first}'s next session.`}
        />

        <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM}>
          <FormRows>
            <Controller
              control={form.control}
              name="role"
              render={({ field, fieldState }) => (
                <FormRow
                  label="Role"
                  labelHidden
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                  description={
                    roleChangeNote(first, currentRole, field.value) ? (
                      <span className="text-foreground">{roleChangeNote(first, currentRole, field.value)}</span>
                    ) : undefined
                  }
                >
                  <RoleChoices
                    id={`${ids}-role`}
                    value={field.value}
                    onChange={field.onChange}
                    currentRole={currentRole}
                    disabled={isSaving}
                    invalid={fieldState.invalid}
                  />
                </FormRow>
              )}
            />
          </FormRows>

          <ActionDialogFooter>
            <CancelButton onClick={() => onOpenChange(false)} disabled={isSaving} />
            <SubmitButton pending={isSaving} pendingLabel="Saving…" disabled={watchedRole === currentRole}>
              {watchedRole === currentRole ? "Change role" : `Change to ${roleLabel(watchedRole)}`}
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
