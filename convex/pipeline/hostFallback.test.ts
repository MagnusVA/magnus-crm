import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { bookingHarness, bookingPayload, mapEventTypeToProgram } from "../../tests/bookingHarness";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import { insertLeadAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";

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
    await forceOpportunityState(ctx, opportunityId, {
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

it.each([
  { host: "admin", mapped: false, outcome: { status: "ignored", reason: "non_closer_host" } },
  { host: "admin", mapped: true, outcome: { status: "ignored", reason: "non_closer_host" } },
  { host: "unknown", mapped: true, outcome: { status: "blocked", reason: "host_not_linked" } },
  { host: "unmatched_member", mapped: true, outcome: { status: "blocked", reason: "host_not_linked" } },
  { host: "unknown", mapped: false, outcome: { status: "ignored", reason: "unlinked_host_unmapped_event_type" } },
  { host: "unmatched_member", mapped: false, outcome: { status: "ignored", reason: "unlinked_host_unmapped_event_type" } },
])(
  "does not create a meeting without an eligible opportunity or closer ($host, program event type: $mapped)",
  async ({ host, mapped, outcome }) => {
    vi.useFakeTimers();
    const { t, tenantId, admin } = await bookingHarness();
    const payload = bookingPayload("untracked");
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
      if (mapped) await mapEventTypeToProgram(ctx, tenantId, payload.scheduled_event.event_type);
    });
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
    expect(receipt).toMatchObject(outcome);
    expect(await t.run((ctx) => ctx.db.query("meetings").take(1))).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("opportunities").take(1))).toHaveLength(0);
    // A booking the pipeline does not track leaves no lead or identifier behind.
    expect(await t.run((ctx) => ctx.db.query("leads").take(1))).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("leadIdentifiers").take(1))).toHaveLength(0);
    // An ignored delivery's raw event is settled, so it raises no stuck-event alert.
    const raw = await t.run((ctx) => ctx.db.get("rawWebhookEvents", receipt.rawEventId));
    expect(raw?.processed).toBe(outcome.status === "ignored");
  },
);

it("holds an unlinked host's booking whose payload names no event type", async () => {
  vi.useFakeTimers();
  const { t, tenantId, admin } = await bookingHarness();
  const payload = bookingPayload("no-event-type");
  payload.scheduled_event.event_memberships[0].user = "https://api.calendly.com/users/unknown";
  const { event_type: _eventType, ...scheduledEvent } = payload.scheduled_event;
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload: { ...payload, scheduled_event: scheduledEvent } }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [receipt] = (await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  })).page;
  expect(receipt).toMatchObject({ status: "blocked", reason: "host_not_linked" });
});

it("ignores the cancel of an unlinked host's booking on an unmapped event type", async () => {
  vi.useFakeTimers();
  const { t, tenantId, admin } = await bookingHarness();
  const payload = bookingPayload("untracked");
  payload.scheduled_event.event_memberships[0].user = "https://api.calendly.com/users/unknown";
  for (const eventType of ["invitee.created", "invitee.canceled"]) {
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType,
      payload: JSON.stringify({ payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  const { page } = await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(page.map((row) => [row.eventType, row.status, row.reason]).sort()).toEqual([
    ["invitee.canceled", "ignored", "unlinked_host_unmapped_event_type"],
    ["invitee.created", "ignored", "unlinked_host_unmapped_event_type"],
  ]);
});

it("won't replay an unlinked host's ignored booking, even once the host is linked", async () => {
  vi.useFakeTimers();
  const { t, tenantId, admin } = await bookingHarness();
  const payload = bookingPayload("unlinked-host");
  payload.scheduled_event.event_memberships[0].user = "https://api.calendly.com/users/new_closer";
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [ignored] = (await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 10 },
  })).page;
  expect(ignored).toMatchObject({ status: "ignored", reason: "unlinked_host_unmapped_event_type" });
  await t.run(async (ctx) => {
    const closer = await ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer")).unique();
    await ctx.db.patch("users", closer!._id, {
      calendlyUserUri: "https://api.calendly.com/users/new_closer",
    });
  });
  await expect(
    (async () =>
      await admin.mutation(api.pipeline.recovery.retry, {
        manifest: await admin.query(api.pipeline.recovery.preview, { deliveryIds: [ignored._id] }),
      }))(),
  ).rejects.toThrow("Only blocked or failed deliveries can be retried");
  expect(await t.run((ctx) => ctx.db.query("meetings").take(1))).toHaveLength(0);
});

it("attaches an admin-hosted booking to the lead's Slack-qualified opportunity without a new lead", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
  const { t, tenantId, admin } = await bookingHarness();
  const { leadId, opportunityId, closerId } = await t.run(async (ctx) => {
    const adminUser = await ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin")).unique();
    await ctx.db.patch("users", adminUser!._id, {
      calendlyUserUri: "https://api.calendly.com/users/admin",
    });
    const closer = await ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer")).unique();
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      email: "lead@example.com",
      status: "active",
      firstSeenAt: Date.parse("2026-09-30T08:00:00Z"),
      updatedAt: Date.parse("2026-09-30T08:00:00Z"),
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId, leadId,
      status: "qualified_pending",
      source: "slack_qualified",
      assignedCloserId: closer!._id,
      createdAt: Date.parse("2026-09-30T08:00:00Z"),
      updatedAt: Date.parse("2026-09-30T08:00:00Z"),
    });
    await insertLeadAggregate(ctx, leadId);
    await insertOpportunityAggregate(ctx, opportunityId);
    return { leadId, opportunityId, closerId: closer!._id };
  });
  const payload = bookingPayload("slack-admin");
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
  expect(receipt).toMatchObject({ status: "applied", opportunityId, leadId });
  const state = await t.run(async (ctx) => ({
    leads: await ctx.db.query("leads").take(5),
    opportunity: await ctx.db.get("opportunities", opportunityId),
    meeting: await ctx.db.get("meetings", receipt.meetingId!),
  }));
  expect(state.leads.map((l) => l._id)).toEqual([leadId]);
  expect(state.opportunity).toMatchObject({ status: "scheduled", assignedCloserId: closerId });
  expect(state.meeting).toMatchObject({ assignedCloserId: closerId, status: "scheduled" });
});
