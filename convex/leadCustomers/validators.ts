import { v } from "convex/values";

export const leadCustomerLifecycleValidator = v.union(
  v.literal("lead"),
  v.literal("customer"),
  v.literal("merged"),
);

export const leadCustomerLifecycleFilterValidator = v.union(
  v.literal("all"),
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
