import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";

const OAUTH_STATE_RETENTION_MS = 24 * 60 * 60 * 1000;

export const findExpiredOAuthStates = internalQuery({
  args: {
    cutoff: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("slackOAuthStates")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", args.cutoff))
      .take(args.limit);
    return rows.map((row) => row._id);
  },
});

export const deleteOAuthStatesByIds = internalMutation({
  args: { ids: v.array(v.id("slackOAuthStates")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.delete(id);
    }
  },
});

export const deleteExpiredOAuthStates = internalAction({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - OAUTH_STATE_RETENTION_MS;
    let deleted = 0;

    for (let i = 0; i < 10; i++) {
      const ids = await ctx.runQuery(
        internal.slack.cleanup.findExpiredOAuthStates,
        {
          cutoff,
          limit: 200,
        },
      );
      if (ids.length === 0) break;

      await ctx.runMutation(
        internal.slack.cleanup.deleteOAuthStatesByIds,
        { ids },
      );
      deleted += ids.length;
    }

    console.log("[Slack:Cleanup] oauth states", { deleted });
    return { deleted };
  },
});

export const findExpiredRawEvents = internalQuery({
  args: {
    cutoff: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("rawSlackEvents")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", args.cutoff))
      .take(args.limit);
    return rows.map((row) => row._id);
  },
});

export const deleteRawEventsByIds = internalMutation({
  args: { ids: v.array(v.id("rawSlackEvents")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.delete(id);
    }
  },
});

export const deleteExpiredRawEvents = internalAction({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now();
    let deleted = 0;

    for (let i = 0; i < 10; i++) {
      const ids = await ctx.runQuery(
        internal.slack.cleanup.findExpiredRawEvents,
        {
          cutoff,
          limit: 200,
        },
      );
      if (ids.length === 0) break;

      await ctx.runMutation(internal.slack.cleanup.deleteRawEventsByIds, {
        ids,
      });
      deleted += ids.length;
    }

    console.log("[Slack:Cleanup] raw events", { deleted });
    return { deleted };
  },
});
