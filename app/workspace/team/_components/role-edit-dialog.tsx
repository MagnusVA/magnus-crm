"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

type CrmRole = "tenant_admin" | "closer";

const roleOptions: Array<{ value: CrmRole; label: string }> = [
  { value: "closer", label: "Closer" },
  { value: "tenant_admin", label: "Admin" },
];

interface RoleEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: Id<"users">;
  userName: string;
  currentRole: string;
  onSuccess?: () => void;
}

export function RoleEditDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentRole,
  onSuccess,
}: RoleEditDialogProps) {
  const [selectedRole, setSelectedRole] = useState<CrmRole>(
    currentRole as CrmRole,
  );
  const [isSaving, setIsSaving] = useState(false);
  const updateRole = useAction(api.workos.userManagement.updateUserRole);

  const handleSave = async () => {
    if (selectedRole === currentRole) {
      onOpenChange(false);
      return;
    }

    setIsSaving(true);
    try {
      await updateRole({ userId, newRole: selectedRole });
      toast.success(`${userName}'s role updated to ${roleOptions.find((r) => r.value === selectedRole)?.label}`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update role",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Change Role</DialogTitle>
          <DialogDescription>
            Update the role for {userName}. Role changes take effect on their
            next session.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="newRole">New Role</FieldLabel>
            <Select
              value={selectedRole}
              onValueChange={(v) => setSelectedRole(v as CrmRole)}
            >
              <SelectTrigger id="newRole" disabled={isSaving}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>

        <div className="flex justify-end gap-2 pt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving || selectedRole === currentRole}
          >
            {isSaving && <Spinner data-icon="inline-start" />}
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
