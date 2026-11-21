import { Workpool } from "@convex-dev/workpool";
import { components } from "../_generated/api";

// Independent budgets prevent report backfills from starving incoming bookings.
export const webhookPool = new Workpool(components.webhookWorkpool, {
  maxParallelism: 4,
});
export const reportingPool = new Workpool(components.reportingWorkpool, {
  maxParallelism: 2,
});
// Whop refreshes and sweeps. Two workers: one connection's request clock
// already spaces its calls.
export const providerPool = new Workpool(components.providerWorkpool, {
  maxParallelism: 2,
});
