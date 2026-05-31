import { v } from "convex/values";

export const leadGenSourceValidator = v.union(
  v.literal("instagram"),
  v.literal("meta_business"),
);

export const leadGenOriginKindValidator = v.union(
  v.literal("post"),
  v.literal("reel"),
  v.literal("story_poll"),
  v.literal("story"),
  v.literal("follower"),
  v.literal("application"),
  v.literal("source_only"),
  // Legacy values retained so existing rows continue to validate.
  v.literal("meta_business"),
  v.literal("other"),
);

export const leadGenAuditMatchSourceValidator = v.union(
  v.literal("slack_qualification"),
  v.literal("admin_correction"),
);

export const leadGenAuditMatchStatusValidator = v.union(
  v.literal("candidate"),
  v.literal("accepted"),
  v.literal("rejected"),
);

export const leadGenWeekdayValidator = v.union(
  v.literal("monday"),
  v.literal("tuesday"),
  v.literal("wednesday"),
  v.literal("thursday"),
  v.literal("friday"),
  v.literal("saturday"),
  v.literal("sunday"),
);

export const leadGenSubmitArgsValidator = {
  source: leadGenSourceValidator,
  rawHandleOrProfileUrl: v.string(),
  originKind: leadGenOriginKindValidator,
  originUrlOrLabel: v.optional(v.string()),
  clientSubmissionKey: v.optional(v.string()),
};
