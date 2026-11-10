import { defineTable } from "convex/server";
import { v } from "convex/values";

/** One Jev answer to a choice question. */
export const secondOpinionChoiceValidator = v.object({
  choice: v.string(),
  confidence: v.optional(v.number()),
  probabilities: v.optional(v.record(v.string(), v.number())),
});

export const secondOpinionRecordKindValidator = v.union(
  v.literal("payment"),
  v.literal("call_back"),
  v.literal("lost"),
  v.literal("no_show"),
);

export const secondOpinionVerdictValidator = v.union(
  v.literal("agrees"),
  v.literal("unsure"),
  v.literal("disagrees"),
  // Nothing was recorded to compare, after the business day closed.
  v.literal("hint"),
);

/** Jev's check of one recorded call (docs/plans/closer-assistant.md §6.9). */
export const secondOpinionTables = {
  secondOpinions: defineTable({
    tenantId: v.id("tenants"),
    meetingId: v.id("meetings"),
    recordingId: v.id("callRecordings"),
    // The meeting's closer when the check ran.
    closerUserId: v.id("users"),
    trigger: v.union(
      v.literal("result_recorded"),
      v.literal("recording_matched"),
      v.literal("day_closed"),
    ),
    // What the closer recorded. None for day_closed.
    record: v.optional(
      v.object({
        kind: secondOpinionRecordKindValidator,
        paymentType: v.optional(v.string()),
        amountMinor: v.optional(v.number()),
        currency: v.optional(v.string()),
        lossReason: v.optional(v.string()),
      }),
    ),
    // The statement Magnus built from the record, rated by Jev.
    claim: v.optional(v.string()),
    // meetingId and recordingId, so a check runs once per pair.
    inputKey: v.string(),
    model: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("answered"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    attempts: v.number(),
    failure: v.optional(
      v.union(
        v.literal("upstream_error"),
        v.literal("format_changed"),
        v.literal("rejected"),
        v.literal("no_transcript"),
        v.literal("cap_reached"),
        v.literal("disabled"),
      ),
    ),
    answers: v.optional(
      v.object({
        attendance: secondOpinionChoiceValidator,
        ending: secondOpinionChoiceValidator,
        objection: secondOpinionChoiceValidator,
        claim: v.optional(v.number()),
      }),
    ),
    verdict: v.optional(secondOpinionVerdictValidator),
    // Measured by Magnus from the transcript's timestamps, not by Jev.
    evidence: v.optional(
      v.object({
        recordedMinutes: v.number(),
        closerMinutes: v.number(),
        prospectMinutes: v.number(),
        prospectFirstAt: v.optional(v.number()),
        // One letter per minute: c closer, p prospect, q silence.
        talkPattern: v.optional(v.string()),
      }),
    ),
    gatewayRequestId: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    costUsd: v.optional(v.number()),
    closerNote: v.optional(v.string()),
    closerNoteAt: v.optional(v.number()),
    reviewState: v.optional(v.union(v.literal("open"), v.literal("checked"))),
    review: v.optional(
      v.object({
        outcome: v.union(
          v.literal("closer_right"),
          v.literal("second_opinion_right"),
        ),
        byUserId: v.id("users"),
        at: v.number(),
        reopened: v.boolean(),
        note: v.optional(v.string()),
      }),
    ),
    createdAt: v.number(),
    answeredAt: v.optional(v.number()),
  })
    .index("by_meetingId", ["meetingId"])
    .index("by_tenantId_and_inputKey", ["tenantId", "inputKey"])
    .index("by_tenantId_and_reviewState_and_createdAt", [
      "tenantId",
      "reviewState",
      "createdAt",
    ])
    .index("by_tenantId_and_verdict_and_createdAt", ["tenantId", "verdict", "createdAt"])
    .index("by_tenantId_and_closerUserId_and_reviewState_and_createdAt", [
      "tenantId",
      "closerUserId",
      "reviewState",
      "createdAt",
    ])
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"]),
};
