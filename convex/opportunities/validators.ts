import { v } from "convex/values";

export const opportunitySourceValidator = v.union(
  v.literal("calendly"),
  v.literal("side_deal"),
);

export const opportunityStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("meeting_overran"),
  v.literal("payment_received"),
  v.literal("follow_up_scheduled"),
  v.literal("reschedule_link_sent"),
  v.literal("lost"),
  v.literal("canceled"),
  v.literal("no_show"),
);

export const periodFilterValidator = v.optional(
  v.union(
    v.literal("today"),
    v.literal("this_week"),
    v.literal("this_month"),
  ),
);

export const socialHandleValidator = v.object({
  platform: v.union(
    v.literal("instagram"),
    v.literal("tiktok"),
    v.literal("twitter"),
    v.literal("facebook"),
    v.literal("linkedin"),
    v.literal("other_social"),
  ),
  handle: v.string(),
});

export const newLeadInputValidator = v.object({
  fullName: v.string(),
  email: v.string(),
  phone: v.optional(v.string()),
  socialHandle: v.optional(socialHandleValidator),
});
