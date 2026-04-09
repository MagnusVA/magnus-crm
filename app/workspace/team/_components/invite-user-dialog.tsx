"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useAction } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { PlusIcon } from "lucide-react";
import posthog from "posthog-js";

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
    role: z.enum(["closer", "tenant_admin"]),
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
}

export function InviteUserDialog({ onSuccess }: InviteUserDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize the form with Zod resolver
  const form = useForm({
    resolver: standardSchemaResolver(inviteUserSchema),
    defaultValues: {
      email: "",
      firstName: "",
      lastName: "",
      role: "closer",
      calendlyMemberId: undefined,
    },
  });

  // Watch role to conditionally render the Calendly member field
  const watchedRole = form.watch("role");

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
      posthog.captureException(error);
      toast.error(
        error instanceof Error ? error.message : "Failed to invite user",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

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
        <Button>
          <PlusIcon data-icon="inline-start" />
          Invite User
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Invite Team Member</DialogTitle>
          <DialogDescription>
            Add a new member to your team. Closers require a Calendly link.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              {/* Email */}
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Email <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="user@example.com"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* First Name */}
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      First Name <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="John"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Last Name (optional) */}
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Last Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Doe"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Role */}
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Role <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // Clear Calendly member when switching away from closer
                        if (value !== "closer") {
                          form.setValue("calendlyMemberId", undefined);
                        }
                      }}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="closer">Closer</SelectItem>
                        <SelectItem value="tenant_admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Calendly Member — only visible when role is "closer" */}
              {watchedRole === "closer" && (
                <FormField
                  control={form.control}
                  name="calendlyMemberId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Calendly Member{" "}
                        <span className="text-destructive">*</span>
                      </FormLabel>
                      <Select
                        value={field.value ?? ""}
                        onValueChange={field.onChange}
                        disabled={isSubmitting || !unmatchedMembers}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a Calendly member" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {unmatchedMembers?.map((member) => (
                            <SelectItem key={member._id} value={member._id}>
                              {member.name ?? member.email} ({member.email})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Only unmatched Calendly members are shown
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </FieldGroup>

            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  form.reset();
                }}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Inviting...
                  </>
                ) : (
                  "Invite"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
