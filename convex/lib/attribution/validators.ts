import { v } from "convex/values";

export const attributionResolutionValidator = v.union(
  v.literal("mapped"),
  v.literal("unmapped"),
  v.literal("internal"),
  v.literal("none"),
);

export const bookingProgramMappingStatusValidator = v.union(
  v.literal("mapped"),
  v.literal("unmapped"),
);
