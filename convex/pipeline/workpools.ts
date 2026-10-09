import { Workpool } from "@convex-dev/workpool";
import { components } from "../_generated/api";

// Independent budgets prevent report backfills from starving incoming bookings.
export const webhookPool = new Workpool(components.webhookWorkpool, {
  maxParallelism: 4,
});
export const reportingPool = new Workpool(components.reportingWorkpool, {
  maxParallelism: 2,
});
