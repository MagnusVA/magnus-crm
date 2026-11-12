import { v } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { mutation, query } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { readLiveQueryRows } from "../../lib/liveQueryBounds";
import { requireAdminContext } from "./cases";
import { upperBound } from "./stats";

type Header = Extract<Doc<"callInsightFacts">, { kind: "call" }>;
export function waitFigures(headers: Header[]) {
  const figures = ([5, 7, 10] as const).map((w) => {
    let late = 0,
      unresolved = 0;
    for (const h of headers) {
      const confirmed = h.confirmedArrivalOffsetSeconds;
      const ascertained =
        (h.startOffsetSeconds ?? Infinity) <= 0 &&
        (h.endOffsetSeconds ?? -Infinity) >= w * 60 &&
        (h.prospectIdentity === "email_matched" ||
          h.prospectIdentity === "closer_confirmed") &&
        h.prospectFirstLineOffsetSeconds !== undefined;
      const arrival =
        confirmed ??
        (ascertained ? h.prospectFirstLineOffsetSeconds : undefined);
      if (arrival === undefined) {
        unresolved++;
        late++;
      } else if (arrival > w * 60) late++;
    }
    const bound = upperBound(late, headers.length);
    return {
      w,
      n: headers.length,
      late,
      unresolved,
      upperBound: bound,
      pass: bound <= 0.05,
    };
  });
  return {
    waits: figures,
    leftCensoredShare: headers.length
      ? headers.filter((h) => (h.startOffsetSeconds ?? 0) > 0).length /
        headers.length
      : 0,
    needed: 59,
  };
}
export const waitStudy = query({
  args: {},
  returns: v.object({
    waits: v.array(
      v.object({
        w: v.number(),
        n: v.number(),
        late: v.number(),
        unresolved: v.number(),
        upperBound: v.number(),
        pass: v.boolean(),
      }),
    ),
    leftCensoredShare: v.number(),
    needed: v.number(),
    unresolvedCalls: v.array(
      v.object({
        recordingId: v.id("callRecordings"),
        meetingId: v.id("meetings"),
        leadName: v.string(),
        scheduledAt: v.number(),
      }),
    ),
    capped: v.boolean(),
  }),
  handler: async (ctx) => {
    const me = await requireAdminContext(ctx);
    const tenant = await ctx.db.get("tenants", me.tenantId);
    if (!tenant?.callInsights)
      return { ...waitFigures([]), unresolvedCalls: [], capped: false };
    const read = await readLiveQueryRows(
      ctx.db
        .query("callInsightFacts")
        .withIndex("by_tenantId_and_kind_and_scheduledAt", (q) =>
          q
            .eq("tenantId", me.tenantId)
            .eq("kind", "call")
            .gte("scheduledAt", tenant.callInsights!.enabledAt),
        ),
      500,
    );
    const people = new Set<string>(),
      headers: Header[] = [],
      unresolvedCalls = [];
    for (const h of read.rows) {
      if (h.kind !== "call" || !h.active) continue;
      const meeting = await ctx.db.get("meetings", h.meetingId);
      if (
        !meeting ||
        meeting.tenantId !== me.tenantId ||
        meeting.status !== "held"
      )
        continue;
      const deal = await ctx.db.get("opportunities", meeting.opportunityId);
      if (!deal || deal.tenantId !== me.tenantId || people.has(deal.leadId))
        continue;
      people.add(deal.leadId);
      headers.push(h);
      if (
        h.confirmedArrivalOffsetSeconds === undefined &&
        !(
          (h.startOffsetSeconds ?? Infinity) <= 0 &&
          (h.endOffsetSeconds ?? -Infinity) >= 600 &&
          (h.prospectIdentity === "email_matched" ||
            h.prospectIdentity === "closer_confirmed") &&
          h.prospectFirstLineOffsetSeconds !== undefined
        )
      ) {
        const lead = await ctx.db.get("leads", deal.leadId);
        unresolvedCalls.push({
          recordingId: h.recordingId,
          meetingId: h.meetingId,
          leadName:
            lead?.tenantId === me.tenantId
              ? (lead.fullName ?? "Unknown person")
              : "Unknown person",
          scheduledAt: h.scheduledAt,
        });
      }
      // The policy fixes its decision sample in advance at the zero-error floor.
      if (headers.length === 59) break;
    }
    return { ...waitFigures(headers), unresolvedCalls, capped: read.capped };
  },
});
export const confirmArrival = mutation({
  args: {
    recordingId: v.id("callRecordings"),
    arrivedMinutesAfterStart: v.union(v.number(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireAdminContext(ctx);
    if (
      args.arrivedMinutesAfterStart !== null &&
      !Number.isFinite(args.arrivedMinutesAfterStart)
    )
      throw rejectRequest(
        "call_insights.eval_arrival",
        "Enter a finite arrival offset.",
      );
    const header = await ctx.db
      .query("callInsightFacts")
      .withIndex("by_recordingId_and_kind", (q) =>
        q.eq("recordingId", args.recordingId).eq("kind", "call"),
      )
      .first();
    if (!header || header.kind !== "call" || header.tenantId !== me.tenantId)
      throw rejectRequest(
        "call_insights.eval_call_unavailable",
        "This call is unavailable.",
      );
    await ctx.db.patch("callInsightFacts", header._id, {
      confirmedArrivalOffsetSeconds:
        args.arrivedMinutesAfterStart === null
          ? undefined
          : args.arrivedMinutesAfterStart * 60,
      // Clearing a confirmation removes its identity claim. An email-matched line
      // retains its own provenance; other cleared confirmations need review again.
      prospectIdentity:
        args.arrivedMinutesAfterStart === null
          ? header.prospectIdentity === "closer_confirmed"
            ? "unknown"
            : header.prospectIdentity
          : "closer_confirmed",
      updatedAt: Date.now(),
    });
    return null;
  },
});
