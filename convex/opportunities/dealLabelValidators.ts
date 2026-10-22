import { v, type Infer } from "convex/values";
import type { DealPosition, SystemLossReason } from "./stages";

// Validators for the deal label fields (stageLabels.ts) that a query's
// `returns` or args name: the six positions, and the loss the system wrote.

export const dealPositionValidator = v.union(
  v.literal("qualified"),
  v.literal("booked"),
  v.literal("call_held"),
  v.literal("follow_up"),
  v.literal("won"),
  v.literal("lost"),
);

export const systemLossReasonValidator = v.union(
  v.literal("stale"),
  v.literal("no_show"),
  v.literal("canceled"),
);

// The validators name exactly the stage module's positions and system losses.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const positionsMatch: Same<Infer<typeof dealPositionValidator>, DealPosition> = true;
const systemLossesMatch: Same<Infer<typeof systemLossReasonValidator>, SystemLossReason> = true;
void positionsMatch;
void systemLossesMatch;
