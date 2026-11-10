import { defineTable } from "convex/server";
import { v } from "convex/values";

const callGroupValidator = v.object({
  scheduled: v.number(),
  held: v.number(),
  noShow: v.number(),
  canceled: v.number(),
  notRecorded: v.number(),
  // Held ÷ held plus no-show, or null when both are zero.
  showRate: v.union(v.number(), v.null()),
});

/** The numbers an end-of-day report counts, snapshotted when it's made. */
export const endOfDayNumbersValidator = v.object({
  newCalls: callGroupValidator,
  followUpCalls: callGroupValidator,
  // Deals whose first held call fell in the window, and how many are won now.
  closeRate: v.object({ cohort: v.number(), won: v.number() }),
  deals: v.object({
    won: v.number(),
    deposits: v.number(),
    lost: v.number(),
    followUp: v.number(),
  }),
  money: v.array(
    v.object({
      currency: v.string(),
      cashMinor: v.number(),
      depositsMinor: v.number(),
    }),
  ),
  callbacks: v.object({
    due: v.number(),
    done: v.number(),
    pending: v.number(),
  }),
  overran: v.number(),
  // One line per deal behind the window's calls: first name and last
  // initial only, under decision 10.
  people: v.array(
    v.object({
      kind: v.union(
        v.literal("won"),
        v.literal("deposit"),
        v.literal("lost"),
        v.literal("follow_up"),
        v.literal("no_show"),
      ),
      callType: v.union(v.literal("new"), v.literal("follow_up")),
      name: v.string(),
      program: v.optional(v.string()),
      amountMinor: v.optional(v.number()),
      currency: v.optional(v.string()),
      paymentType: v.optional(v.string()),
      // Mixed currencies/programs stay separate, on the same person's line.
      amounts: v.optional(
        v.array(
          v.object({
            amountMinor: v.number(),
            currency: v.string(),
            program: v.string(),
            paymentType: v.string(),
          }),
        ),
      ),
    }),
  ),
});

export const endOfDayGapValidator = v.object({
  kind: v.union(
    v.literal("not_recorded"),
    v.literal("overdue_task"),
    v.literal("unmatched_recording"),
    v.literal("second_opinion"),
  ),
  label: v.string(),
  meetingId: v.optional(v.id("meetings")),
  followUpId: v.optional(v.id("followUps")),
  recordingId: v.optional(v.id("callRecordings")),
});

export const endOfDayTables = {
  endOfDayReports: defineTable({
    tenantId: v.id("tenants"),
    userId: v.id("users"),
    // Widened when another role ends days.
    role: v.literal("closer"),
    periodStart: v.number(),
    periodEnd: v.number(),
    timeZone: v.string(),
    previousReportId: v.optional(v.id("endOfDayReports")),
    previousDayUnclosed: v.boolean(),
    numbers: endOfDayNumbersValidator,
    gaps: v.array(endOfDayGapValidator),
    narrativeMarkdown: v.optional(v.string()),
    note: v.optional(v.string()),
    endedVia: v.union(v.literal("agent"), v.literal("web")),
    agentClient: v.optional(v.string()),
    slackStatus: v.union(
      v.literal("pending"),
      v.literal("posted"),
      v.literal("not_configured"),
      v.literal("failed"),
    ),
    slackChannelId: v.optional(v.string()),
    slackChannelName: v.optional(v.string()),
    slackTs: v.optional(v.string()),
    // A second report the same shift replies in the first one's thread.
    slackThreadTs: v.optional(v.string()),
    // Stable root even when the first report's scheduled post is still pending.
    slackThreadReportId: v.optional(v.id("endOfDayReports")),
    slackError: v.optional(v.string()),
    // A short action lease prevents duplicate scheduled invocations posting twice.
    slackPostStartedAt: v.optional(v.number()),
    slackPostAttempt: v.optional(v.string()),
    postedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_tenantId_and_userId_and_periodEnd", [
      "tenantId",
      "userId",
      "periodEnd",
    ])
    .index("by_tenantId_and_periodEnd", ["tenantId", "periodEnd"]),
};
