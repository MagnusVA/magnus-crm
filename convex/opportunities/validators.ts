import { v } from "convex/values";

export const opportunitySourceValidator = v.union(
  v.literal("calendly"),
  v.literal("side_deal"),
  v.literal("slack_qualified"),
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

// A side deal's new person needs an email, a phone or a social handle, at
// least one (docs/plans/phase-4-customers.md D8); createManual checks it.
export const newLeadInputValidator = v.object({
  fullName: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  socialHandle: v.optional(socialHandleValidator),
});
