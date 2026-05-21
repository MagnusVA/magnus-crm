import { v } from "convex/values";
import { opportunityStatusValidator } from "../opportunities/validators";

export const slackQualificationResultKindValidator = v.union(
  v.literal("created_opportunity"),
  v.literal("duplicate_pending"),
  v.literal("already_booked"),
  v.literal("unlinked"),
);

export const operationsQualificationStatusFilterValidator = v.optional(
  opportunityStatusValidator,
);
