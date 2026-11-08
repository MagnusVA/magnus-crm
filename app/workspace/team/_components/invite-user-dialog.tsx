"use client";

import { useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useAction } from "convex/react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { PlusIcon } from "lucide-react";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  DialogNote,
  FormRow,
  FormRows,
  SubmitButton,
} from "@/app/workspace/_components/action-dialog";
import { RoleChoices } from "./team-dialog-parts";

// ---------------------------------------------------------------------------
// Zod schema — conditional validation via .superRefine()
// ---------------------------------------------------------------------------

const inviteUserSchema = z
  .object({
    email: z
      .string()
      .min(1, "Email is required")
      .email("Please enter a valid email address"),
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().optional(),
    role: z.enum(["closer", "tenant_admin", "lead_generator"]),
    calendlyMemberId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "closer" && !data.calendlyMemberId) {
      ctx.addIssue({
        code: "custom",
        message: "Calendly member is required for Closers",
        path: ["calendlyMemberId"],
      });
    }
  });

type InviteUserFormValues = z.infer<typeof inviteUserSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface InviteUserDialogProps {
  onSuccess?: () => void;
  /** Replaces the "Invite member" button that opens the dialog. */
  trigger?: ReactNode;
  /** Prefills the form, e.g. from a team member with no login yet. */
  defaultValues?: Partial<Pick<InviteUserFormValues, "email" | "firstName" | "lastName" | "role">>;
  /** A ruled note under the header. */
  note?: ReactNode;
}

export function InviteUserDialog({ onSuccess, trigger, defaultValues, note }: InviteUserDialogProps) {
  const ids = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize the form with Zod resolver
  const form = useForm({
    resolver: standardSchemaResolver(inviteUserSchema),
    defaultValues: {
      email: defaultValues?.email ?? "",
      firstName: defaultValues?.firstName ?? "",
      lastName: defaultValues?.lastName ?? "",
      role: defaultValues?.role ?? "closer",
      calendlyMemberId: undefined,
    },
  });

  // Watch role to conditionally render the Calendly member field
  const watchedRole = useWatch({ control: form.control, name: "role" });

  // Queries — unmatched Calendly members for closer assignment
  const unmatchedMembers = useQuery(
    api.users.queries.listUnmatchedCalendlyMembers,
  );

  // Actions
  const inviteUser = useAction(api.workos.userManagement.inviteUser);

  const onSubmit = async (values: InviteUserFormValues) => {
    setIsSubmitting(true);
    try {
      await inviteUser({
        email: values.email,
        firstName: values.firstName,
        lastName: values.lastName || undefined,
        role: values.role,
        calendlyMemberId:
          values.role === "closer"
            ? (values.calendlyMemberId as Id<"calendlyOrgMembers">)
            : undefined,
      });

      posthog.capture("team_member_invited", {
        role: values.role,
        has_calendly_member: values.role === "closer",
      });
      toast.success("User invited successfully");
      setOpen(false);
      form.reset();
      onSuccess?.();
      // Re-run server components so the team list reflects the new invite
      router.refresh();
    } catch (error) {
      reportClientError(error, { flow: "team_user_invite" });
      toast.error(
        getErrorMessage(error, "Failed to invite user"),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // From a member card the name is known, so the title names the person.
  const knownName = [defaultValues?.firstName, defaultValues?.lastName].filter(Boolean).join(" ");

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isSubmitting) {
          setOpen(value);
          if (!value) form.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <PlusIcon data-icon="inline-start" />
            Invite member
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={knownName ? `Invite ${knownName} to the CRM` : "Invite someone to the CRM"}
          description="Sends an email with a link to sign up."
        />

        <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM} noValidate>
          {note ? <DialogNote>{note}</DialogNote> : null}
          <FormRows>
            <Controller
              control={form.control}
              name="email"
              render={({ field, fieldState }) => (
                <FormRow label="Email" htmlFor={`${ids}-email`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Input
                    {...field}
                    id={`${ids}-email`}
                    type="email"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="name@company.com"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                  />
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="firstName"
              render={({ field, fieldState }) => (
                <FormRow label="First name" htmlFor={`${ids}-first`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Input
                    {...field}
                    id={`${ids}-first`}
                    autoComplete="off"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                  />
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="lastName"
              render={({ field, fieldState }) => (
                <FormRow label="Last name" htmlFor={`${ids}-last`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Input
                    {...field}
                    id={`${ids}-last`}
                    autoComplete="off"
                    placeholder="Optional"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                  />
                </FormRow>
              )}
            />

            <Controller
              control={form.control}
              name="role"
              render={({ field, fieldState }) => (
                <FormRow label="Role" invalid={fieldState.invalid} error={fieldState.error}>
                  <RoleChoices
                    id={`${ids}-role`}
                    value={field.value}
                    onChange={(value) => {
                      field.onChange(value);
                      // Clear Calendly member when switching away from closer
                      if (value !== "closer") {
                        form.setValue("calendlyMemberId", undefined);
                      }
                    }}
                    disabled={isSubmitting}
                    invalid={fieldState.invalid}
                  />
                </FormRow>
              )}
            />

            {/* Calendly Member — only visible when role is "closer" */}
            {watchedRole === "closer" && (
              <Controller
                control={form.control}
                name="calendlyMemberId"
                render={({ field, fieldState }) => (
                  <FormRow
                    label="Calendly member"
                    htmlFor={`${ids}-calendly`}
                    invalid={fieldState.invalid}
                    error={fieldState.error}
                    description={
                      unmatchedMembers?.length === 0
                        ? "Every Calendly member is already linked to someone."
                        : "Only members not linked to anyone are listed."
                    }
                  >
                    <Select
                      value={field.value ?? ""}
                      onValueChange={field.onChange}
                      disabled={isSubmitting || !unmatchedMembers}
                    >
                      <SelectTrigger
                        id={`${ids}-calendly`}
                        aria-invalid={fieldState.invalid}
                        className="w-full *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate"
                      >
                        <SelectValue placeholder={unmatchedMembers ? "Choose a member" : "Loading members…"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {unmatchedMembers?.map((member) => (
                            <SelectItem key={member._id} value={member._id}>
                              {member.name ?? member.email} ({member.email})
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </FormRow>
                )}
              />
            )}
          </FormRows>

          <ActionDialogFooter>
            <CancelButton
              onClick={() => {
                setOpen(false);
                form.reset();
              }}
              disabled={isSubmitting}
            />
            <SubmitButton pending={isSubmitting} pendingLabel="Sending…">
              Send invite
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
