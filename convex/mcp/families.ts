import { v, type Infer } from "convex/values";

/**
 * The kinds of change an admin's AI assistant can make (docs/plans/admin-assistant.md §4).
 * The owner switches each one on by itself in Settings › AI assistants; a
 * write tool names its family in its metadata, and both the gateway's
 * `authorize` and the tool's own guard refuse it while the family is off.
 */
export const WRITE_FAMILIES = [
  "payments",
  "results",
  "opinions",
  "coverage",
  "repairs",
  "goals",
] as const;

export type WriteFamily = (typeof WRITE_FAMILIES)[number];

export const writeFamilyValidator = v.union(
  v.literal("payments"),
  v.literal("results"),
  v.literal("opinions"),
  v.literal("coverage"),
  v.literal("repairs"),
  v.literal("goals"),
);

export const FAMILY_LABELS: Record<WriteFamily, string> = {
  payments: "Payments",
  results: "Results and next steps",
  opinions: "Second opinions",
  coverage: "Cover a closer",
  repairs: "Repairs",
  goals: "Goals",
};

export type WriteFamilyInfer = Infer<typeof writeFamilyValidator>;

/** The roles that get the admin toolset. */
export const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;
