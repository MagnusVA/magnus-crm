import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import {
  customerConversions,
  leadTimeline,
  meetingsByStatus,
  opportunityByStatus,
  paymentSums,
} from "./aggregates";

const CLASSIFICATION_PAGE_SIZE = 100;
const AGGREGATE_PAGE_SIZE = 200;

export const backfillMeetingClassification = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("meetings").paginate({
      numItems: CLASSIFICATION_PAGE_SIZE,
      cursor: cursor ?? null,
    });

    let updated = 0;
    for (const meeting of result.page) {
      if (meeting.callClassification !== undefined) {
        continue;
      }

      const firstMeeting = await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId_and_scheduledAt", (q) =>
          q.eq("opportunityId", meeting.opportunityId),
        )
        .first();

      await ctx.db.patch(meeting._id, {
        callClassification:
          firstMeeting === null || firstMeeting._id === meeting._id
            ? "new"
            : "follow_up",
      });
      updated += 1;
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillMeetingClassification,
        { cursor: result.continueCursor },
      );
    }

    return {
      hasMore: !result.isDone,
      processed: result.page.length,
      updated,
    };
  },
});

export const backfillMeetingsAggregate = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("meetings").paginate({
      numItems: AGGREGATE_PAGE_SIZE,
      cursor: cursor ?? null,
    });

    for (const meeting of result.page) {
      await meetingsByStatus.insertIfDoesNotExist(ctx, meeting);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillMeetingsAggregate,
        { cursor: result.continueCursor },
      );
    }

    return {
      hasMore: !result.isDone,
      inserted: result.page.length,
    };
  },
});

export const backfillPaymentsAggregate = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("paymentRecords").paginate({
      numItems: AGGREGATE_PAGE_SIZE,
      cursor: cursor ?? null,
    });

    for (const payment of result.page) {
      await paymentSums.insertIfDoesNotExist(ctx, payment);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillPaymentsAggregate,
        { cursor: result.continueCursor },
      );
    }

    return {
      hasMore: !result.isDone,
      inserted: result.page.length,
    };
  },
});

export const backfillOpportunitiesAggregate = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("opportunities").paginate({
      numItems: AGGREGATE_PAGE_SIZE,
      cursor: cursor ?? null,
    });

    for (const opportunity of result.page) {
      await opportunityByStatus.insertIfDoesNotExist(ctx, opportunity);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillOpportunitiesAggregate,
        { cursor: result.continueCursor },
      );
    }

    return {
      hasMore: !result.isDone,
      inserted: result.page.length,
    };
  },
});

export const backfillLeadsAggregate = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("leads").paginate({
      numItems: AGGREGATE_PAGE_SIZE,
      cursor: cursor ?? null,
    });

    for (const lead of result.page) {
      await leadTimeline.insertIfDoesNotExist(ctx, lead);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillLeadsAggregate,
        { cursor: result.continueCursor },
      );
    }

    return {
      hasMore: !result.isDone,
      inserted: result.page.length,
    };
  },
});

export const backfillCustomersAggregate = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("customers").paginate({
      numItems: AGGREGATE_PAGE_SIZE,
      cursor: cursor ?? null,
    });

    for (const customer of result.page) {
      await customerConversions.insertIfDoesNotExist(ctx, customer);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reporting.backfill.backfillCustomersAggregate,
        { cursor: result.continueCursor },
      );
    }

    return {
      hasMore: !result.isDone,
      inserted: result.page.length,
    };
  },
});
