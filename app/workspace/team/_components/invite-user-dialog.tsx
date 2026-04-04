"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FieldGroup,
  Field,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { PlusIcon } from "lucide-react";

type CrmRole = "closer" | "tenant_admin";

interface InviteUserDialogProps {
  onSuccess?: () => void;
}

export function InviteUserDialog({ onSuccess }: InviteUserDialogProps) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<CrmRole>("closer");

  // Form state
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [calendlyMemberId, setCalendlyMemberId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Queries — unmatched Calendly members for closer assignment
  const unmatchedMembers = useQuery(
    api.users.queries.listUnmatchedCalendlyMembers,
  );

  // Actions
  const inviteUser = useAction(api.workos.userManagement.inviteUser);

  const resetForm = () => {
    setEmail("");
    setFirstName("");
    setLastName("");
    setCalendlyMemberId("");
    setRole("closer");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !firstName) {
      toast.error("Please fill in required fields");
      return;
    }

    if (role === "closer" && !calendlyMemberId) {
      toast.error("Calendly member is required for Closers");
      return;
    }

    setIsSubmitting(true);
    try {
      await inviteUser({
        email,
        firstName,
        lastName: lastName || undefined,
        role,
        calendlyMemberId:
          role === "closer"
            ? (calendlyMemberId as Id<"calendlyOrgMembers">)
            : undefined,
      });

      toast.success("User invited successfully");
      setOpen(false);
      resetForm();
      onSuccess?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to invite user",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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

        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="invite-email">Email *</FieldLabel>
              <Input
                id="invite-email"
                type="email"
                placeholder="user@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSubmitting}
                required
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="invite-firstName">First Name *</FieldLabel>
              <Input
                id="invite-firstName"
                placeholder="John"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={isSubmitting}
                required
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="invite-lastName">Last Name</FieldLabel>
              <Input
                id="invite-lastName"
                placeholder="Doe"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={isSubmitting}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="invite-role">Role *</FieldLabel>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as CrmRole)}
              >
                <SelectTrigger id="invite-role" disabled={isSubmitting}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="closer">Closer</SelectItem>
                  <SelectItem value="tenant_admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {role === "closer" && (
              <Field>
                <FieldLabel htmlFor="invite-calendlyMember">
                  Calendly Member *
                </FieldLabel>
                <Select
                  value={calendlyMemberId}
                  onValueChange={setCalendlyMemberId}
                >
                  <SelectTrigger
                    id="invite-calendlyMember"
                    disabled={isSubmitting || !unmatchedMembers}
                  >
                    <SelectValue placeholder="Select a Calendly member" />
                  </SelectTrigger>
                  <SelectContent>
                    {unmatchedMembers?.map((member) => (
                      <SelectItem key={member._id} value={member._id}>
                        {member.name ?? member.email} ({member.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Only unmatched Calendly members are shown
                </FieldDescription>
              </Field>
            )}
          </FieldGroup>

          <div className="flex justify-end gap-2 pt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Spinner data-icon="inline-start" />}
              {isSubmitting ? "Inviting..." : "Invite"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
