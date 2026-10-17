import { v } from "convex/values";

// `prospect` is a person below Qualified (docs/plans/phase-1-foundations.md
// §7.3). Its rows are hidden from the default list and search.
export const leadCustomerLifecycleValidator = v.union(
  v.literal("prospect"),
  v.literal("lead"),
  v.literal("customer"),
  v.literal("merged"),
);

export const leadCustomerLifecycleFilterValidator = v.union(
  v.literal("all"),
  v.literal("prospect"),
  v.literal("lead"),
  v.literal("customer"),
);

export const leadCustomerLeadStatusValidator = v.union(
  v.literal("active"),
  v.literal("converted"),
  v.literal("merged"),
);

export const leadCustomerCustomerStatusValidator = v.union(
  v.literal("active"),
  v.literal("churned"),
  v.literal("paused"),
);
