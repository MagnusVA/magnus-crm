import { v } from "convex/values";

export const nullableNumber = v.union(v.number(), v.null());
export const attendanceFields = {
  held: v.number(),
  noShow: v.number(),
  notRecorded: v.number(),
};
export const cashValidator = v.object({
  currency: v.string(),
  cashMinor: v.number(),
  finalMinor: v.number(),
});
export const callStatusValidator = v.union(
  v.literal("held"),
  v.literal("no_show"),
  v.literal("not_recorded"),
  v.literal("upcoming"),
  v.literal("canceled"),
  v.literal("moved"),
);
export const callTypeValidator = v.union(
  v.literal("new"),
  v.literal("follow_up"),
);
export const openStageValidator = v.union(
  v.literal("qualified"),
  v.literal("booked"),
  v.literal("call_held"),
  v.literal("follow_up"),
);
