"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

const STATUSES = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "churned", label: "Churned" },
] as const;

interface CustomerStatusControlProps {
  customerId: Id<"customers">;
  currentStatus: "active" | "churned" | "paused";
}

export function CustomerStatusControl({
  customerId,
  currentStatus,
}: CustomerStatusControlProps) {
  const { hasPermission } = useRole();
  const [isUpdating, setIsUpdating] = useState(false);
  const updateStatus = useMutation(api.customers.mutations.updateCustomerStatus);

  if (!hasPermission("customer:edit")) {
    return null;
  }

  const handleStatusChange = async (newStatus: string) => {
    if (newStatus === currentStatus) return;

    setIsUpdating(true);
    try {
      await updateStatus({
        customerId,
        status: newStatus as "active" | "churned" | "paused",
      });
      toast.success(`Customer status updated to ${newStatus}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update status",
      );
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Status</h2>
      <Select
        value={currentStatus}
        onValueChange={handleStatusChange}
        disabled={isUpdating}
      >
        <SelectTrigger className="w-48" aria-label="Customer status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUSES.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
