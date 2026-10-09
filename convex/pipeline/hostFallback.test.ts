import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";

afterEach(() => vi.useRealTimers());

it.each(["utm_follow_up", "heuristic_reschedule", "follow_up", "slack_qualified"])(
  "blocks an opportunity without a closer instead of ignoring it (%s)",
  async (path) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const { t, tenantId, admin } = await bookingHarness();
    const opportunityId = await t.run(async (ctx) => {
      const user = await ctx.db.query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin")).unique();
      await ctx.db.patch("users", user!._id, {
        calendlyUserUri: "https://api.calendly.com/users/admin",
      });
      const leadId = await ctx.db.insert("leads", {
        tenantId,
        email: "lead@example.com",
        status: "active",
        firstSeenAt: Date.parse("2026-10-01T08:00:00Z"),
        updatedAt: Date.parse("2026-10-01T09:00:00Z"),
      });
      return await ctx.db.insert("opportunities", {
        tenantId, leadId,
        status: path === "heuristic_reschedule" ? "canceled"
          : path === "slack_qualified" ? "qualified_pending" : "follow_up_scheduled",
        source: path === "slack_qualified" ? "slack_qualified" : "calendly",
        createdAt: Date.parse("2026-10-01T08:00:00Z"),
        updatedAt: Date.parse("2026-10-01T09:00:00Z"),
      });
    });
    const payload = {
      ...bookingPayload("no-closer"),
      ...(path === "utm_follow_up" ? { tracking: {
        utm_source: "ptdom", utm_campaign: opportunityId,
      } } : {}),
    };
    payload.scheduled_event.event_memberships[0].user = "https://api.calendly.com/users/admin";
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ created_at: "2026-10-01T10:00:00Z", payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [receipt] = (await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    })).page;
    expect(receipt).toMatchObject({ status: "blocked", reason: "host_not_linked" });
    expect(await t.run((ctx) => ctx.db.query("meetings").take(1))).toHaveLength(0);
  },
);

const paths = [
  "utm_follow_up",
  "utm_reschedule",
  "heuristic_reschedule",
  "provider_reschedule",
  "follow_up",
  "slack_qualified",
] as const;

it.each(paths.flatMap((path) => [
  { path, host: "admin" },
  { path, host: "unknown" },
]))("uses the opportunity's closer for $path booked with $host", async ({ path, host }) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  const { t, tenantId, admin } = await bookingHarness();
  const old = bookingPayload("original");
  async function deliver(payload: ReturnType<typeof bookingPayload>, created_at: string) {
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ created_at, payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  await deliver(old, "2026-10-01T09:00:00Z");
  const [original] = (await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  })).page;
  if (!original.opportunityId || !original.meetingId) throw new Error("Fixture booking failed");
  const opportunityId = original.opportunityId;
  const before = await admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId: original.meetingId,
  });
  await t.run(async (ctx) => {
    const adminUser = await ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin")).unique();
    await ctx.db.patch("users", adminUser!._id, {
      calendlyUserUri: "https://api.calendly.com/users/admin",
    });
    await patchOpportunityLifecycle(ctx, opportunityId, {
      status: path === "utm_reschedule" ? "reschedule_link_sent"
        : path === "heuristic_reschedule" ? "canceled"
        : path === "provider_reschedule" ? "scheduled"
        : path === "slack_qualified" ? "qualified_pending" : "follow_up_scheduled",
      source: path === "slack_qualified" ? "slack_qualified" : "calendly",
      updatedAt: Date.parse("2026-10-01T09:30:00Z"),
    });
  });
  const next = {
    ...bookingPayload("replacement"),
    ...(path === "provider_reschedule" ? { old_invitee: old.uri } : {}),
    ...(path.startsWith("utm_") ? { tracking: {
      utm_source: "ptdom",
      utm_medium: path === "utm_reschedule" ? "noshow_resched" : "follow_up",
      utm_campaign: opportunityId,
    } } : {}),
  };
  next.scheduled_event.event_memberships[0].user = `https://api.calendly.com/users/${host}`;
  await deliver(next, "2026-10-01T10:00:00Z");
  const [replacement] = (await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  })).page;
  expect(replacement).toMatchObject({ status: "applied", opportunityId });
  const after = await admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId: replacement.meetingId!,
  });
  expect(after.meeting.assignedCloserId).toBe(before.meeting.assignedCloserId);
  expect(after.opportunity.assignedCloserId).toBe(before.opportunity.assignedCloserId);
  expect(after.opportunity.status).toBe("scheduled");
});

it.each(["admin", "unknown", "unmatched_member"])(
  "does not create a meeting without an eligible opportunity or closer (%s)",
  async (host) => {
    vi.useFakeTimers();
    const { t, tenantId, admin } = await bookingHarness();
    await t.run(async (ctx) => {
      const adminUser = await ctx.db.query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin")).unique();
      await ctx.db.patch("users", adminUser!._id, {
        calendlyUserUri: "https://api.calendly.com/users/admin",
      });
      if (host === "unmatched_member")
        await ctx.db.insert("calendlyOrgMembers", {
          tenantId,
          calendlyUserUri: "https://api.calendly.com/users/unmatched_member",
          calendlyRole: "user",
          email: "unmatched@example.com",
          name: "Unmatched member",
          lastSyncedAt: Date.now(),
        });
    });
    const payload = bookingPayload("untracked");
    payload.scheduled_event.event_memberships[0].user = `https://api.calendly.com/users/${host}`;
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [receipt] = (await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    })).page;
    expect(receipt).toMatchObject(host === "admin"
      ? { status: "ignored", reason: "non_closer_host" }
      : { status: "blocked", reason: "host_not_linked" });
    expect(await t.run((ctx) => ctx.db.query("meetings").take(1))).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("opportunities").take(1))).toHaveLength(0);
  },
);
