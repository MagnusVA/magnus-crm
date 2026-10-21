import { v, type Infer } from "convex/values";

// An enrollment's own status (docs/plans/phase-4-customers.md §4.4).
export const enrollmentStatusValidator = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("churned"),
);

export type EnrollmentStatus = Infer<typeof enrollmentStatusValidator>;
