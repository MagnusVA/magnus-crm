"use client";

import { useRole } from "@/components/auth/role-context";

/**
 * Whether the signed-in user must attach proof to a payment: closers must,
 * admins needn't (docs/plans/closer-assistant.md §5.3). Display only; the
 * payment mutations enforce the rule.
 */
export function useProofRequired(): boolean {
  return useRole().role === "closer";
}
