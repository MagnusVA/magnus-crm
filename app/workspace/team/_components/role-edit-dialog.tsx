"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

const roleEditSchema = z.object({
  role: z.enum(["closer", "tenant_admin"]),
});

type RoleEditFormValues = z.infer<typeof roleEditSchema>;

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
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const updateRole = useAction(api.workos.userManagement.updateUserRole);

  const form = useForm({
    resolver: standardSchemaResolver(roleEditSchema),
    defaultValues: {
      role: currentRole as CrmRole,
    },
  });

  // Watch the role field for no-op detection (save button disable)
  const watchedRole = form.watch("role");

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
      await updateRole({ userId, newRole: values.role });
      toast.success(
        `${userName}'s role updated to ${roleOptions.find((r) => r.value === values.role)?.label}`,
      );
      onOpenChange(false);
      onSuccess?.();
      // Re-run server components so getWorkspaceAccess() picks up fresh CRM data
      router.refresh();
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

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New Role</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={isSaving}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {roleOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSaving || watchedRole === currentRole}
              >
                {isSaving && <Spinner data-icon="inline-start" />}
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
