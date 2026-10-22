import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { migrations } from "../migrations";
import { rebuildQualificationRow } from "../operations/projections";
import { slackQualificationsByUser } from "../reporting/aggregates";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";
import { stageFields } from "../../tests/dealStageFixtures";
import { STALE_EXPIRY_CUTOVER_AT } from "./staleExpiry";

afterEach(() => vi.useRealTimers());

const DAY_MS = 24 * 60 * 60 * 1000;
// After the cutover, so the cron covers deals that expire from here on.
const NOW = Date.parse("2026-11-20T12:00:00Z");
// Older than this at NOW means it expired before the cutover: backlog.
const BACKLOG_AGE_DAYS = (NOW - STALE_EXPIRY_CUTOVER_AT) / DAY_MS + 31 + 1;

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function slackOpportunity(
  harness: Harness,
  ageDays: number,
  options: { status?: Doc<"opportunities">["status"]; email?: string; inAggregate?: boolean } = {},
) {
  const { t, tenantId } = harness;
  return await t.run(async (ctx) => {
    const createdAt = NOW - ageDays * DAY_MS;
    const leadId = await ctx.db.insert("leads", { ...qualifiedLifecycle(createdAt),
      tenantId,
      fullName: `Lead ${ageDays}`,
      email: options.email,
      status: "active",
      firstSeenAt: createdAt,
      updatedAt: createdAt,
    });
    const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: createdAt };
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      status: options.status ?? "qualified_pending",
      source: "slack_qualified",
      qualifiedBy,
      createdAt,
      updatedAt: createdAt,
      latestActivityAt: createdAt,
    });
    if (options.inAggregate !== false) {
      await insertOpportunityAggregate(ctx, opportunityId);
    }
    await updateTenantStats(ctx, tenantId, {
      totalOpportunities: 1,
      activeOpportunities: 1,
    });
    const installation = await ctx.db.query("slackInstallations").first();
    const installationId =
      installation?._id ??
      (await ctx.db.insert("slackInstallations", {
        tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
        botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
        notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
        installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
      }));
    const eventId = await ctx.db.insert("slackQualificationEvents", {
      tenantId, installationId, leadId, opportunityId,
      resultKind: "created_opportunity", qualifiedBy,
      slackUserId: "U1", slackTeamId: "T1", fullNameSnapshot: `Lead ${ageDays}`,
      platform: "instagram", handleSnapshot: `lead.${ageDays}`,
      submittedAt: createdAt, createdAt,
    });
    await rebuildQualificationRow(ctx, eventId);
    return { opportunityId, eventId, createdAt };
  });
}

async function state(harness: Harness, opportunityId: Id<"opportunities">, eventId?: Id<"slackQualificationEvents">) {
  return await harness.t.run(async (ctx) => ({
    opportunity: await ctx.db.get("opportunities", opportunityId),
    row: eventId
      ? await ctx.db
          .query("operationsQualificationRows")
          .withIndex("by_qualificationEventId", (q) => q.eq("qualificationEventId", eventId))
          .unique()
      : null,
  }));
}

async function runCron(harness: Harness) {
  await harness.t.mutation(internal.slack.staleExpiry.expireStaleSlackOpportunities, {});
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
}

it("closes Slack deals a day past the join window and leaves the rest", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  const stale = await slackOpportunity(harness, 32);
  const inDigestWindow = await slackOpportunity(harness, 30.5);
  const fresh = await slackOpportunity(harness, 3);
  const booked = await slackOpportunity(harness, 40, { status: "scheduled" });
  const backlog = await slackOpportunity(harness, BACKLOG_AGE_DAYS);

  await runCron(harness);

  const closed = await state(harness, stale.opportunityId, stale.eventId);
  expect(closed.opportunity).toMatchObject({
    status: "lost",
    lostReason: "stale",
    lostAt: NOW,
    // Nobody worked it, so it doesn't jump to the top of activity sorts.
    latestActivityAt: stale.createdAt,
  });
  expect(closed.row?.opportunityStatus).toBe("lost");
  for (const open of [inDigestWindow, fresh, backlog]) {
    expect((await state(harness, open.opportunityId)).opportunity?.status)
      .toBe("qualified_pending");
  }
  expect((await state(harness, booked.opportunityId)).opportunity?.status).toBe("scheduled");

  const counts = await harness.t.run(async (ctx) => ({
    stats: await ctx.db
      .query("tenantStats")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", harness.tenantId))
      .unique(),
    // An expiry is an outcome, not a lost qualification: the setter's count stays.
    qualifications: await slackQualificationsByUser.count(ctx, {
      namespace: harness.tenantId,
      bounds: { prefix: ["U1"] },
    }),
    events: await ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", harness.tenantId).eq("entityType", "opportunity")
          .eq("entityId", stale.opportunityId),
      )
      .take(5),
  }));
  expect(counts.stats).toMatchObject({ activeOpportunities: 4, lostDeals: 1 });
  expect(counts.qualifications).toBe(5);
  expect(counts.events).toEqual([
    expect.objectContaining({
      eventType: "opportunity.marked_lost",
      source: "system",
      fromStatus: "qualified_pending",
      toStatus: "lost",
      reason: "stale",
    }),
  ]);
});

it("pages through many expired deals, and one that fails doesn't hold up the rest", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  // Oldest first in the scan; missing from the aggregate, so its transition throws.
  const broken = await slackOpportunity(harness, 40, { inAggregate: false });
  const expired: Awaited<ReturnType<typeof slackOpportunity>>[] = [];
  for (let index = 0; index < 55; index += 1) {
    expired.push(await slackOpportunity(harness, 32 + index / 10));
  }

  await runCron(harness);

  const statuses = await harness.t.run(async (ctx) =>
    Promise.all(
      expired.map(async ({ opportunityId }) =>
        (await ctx.db.get("opportunities", opportunityId))?.status,
      ),
    ),
  );
  expect(new Set(statuses)).toEqual(new Set(["lost"]));
  expect((await state(harness, broken.opportunityId)).opportunity?.status)
    .toBe("qualified_pending");
});

it("leaves the pre-cutover backlog to its migration, which the preview counts", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  const backlog = await slackOpportunity(harness, BACKLOG_AGE_DAYS);
  await slackOpportunity(harness, 35);
  await slackOpportunity(harness, 10);

  expect(
    await harness.t.query(internal.slack.staleExpiry.previewStaleSlackOpportunities, {}),
  ).toEqual({
    backlog: 1,
    cronWillClose: 1,
    capped: false,
    oldestCreatedAt: backlog.createdAt,
  });

  const run = async (name: string) => {
    await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}` });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    const [status] = await harness.t.run((ctx) =>
      migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
    );
    return status;
  };
  expect((await run("assertStaleSlackBacklogExpired"))?.error).toContain("still pending");
  await run("expireStaleSlackBacklog");
  const assertion = await run("assertStaleSlackBacklogExpired");
  expect(assertion?.isDone).toBe(true);
  expect(assertion?.error).toBeUndefined();
  expect((await state(harness, backlog.opportunityId)).opportunity).toMatchObject({
    status: "lost",
    lostReason: "stale",
  });
});

it("reopens an expired Slack deal for a booking made inside the window but processed after", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  const slack = await slackOpportunity(harness, 33, { email: "lead@example.com" });
  await harness.t.run(async (ctx) => {
    const opportunity = (await ctx.db.get("opportunities", slack.opportunityId))!;
    await ctx.db.insert("leadIdentifiers", {
      tenantId: harness.tenantId,
      leadId: opportunity.leadId,
      type: "email",
      value: "lead@example.com",
      rawValue: "lead@example.com",
      source: "slack_qualified",
      confidence: "verified",
      createdAt: slack.createdAt,
    });
  });
  await runCron(harness);
  expect((await state(harness, slack.opportunityId)).opportunity?.status).toBe("lost");

  // Booked on day 25, blocked, and retried now: the pipeline judges it by
  // the booking's own time.
  const payload = bookingPayload("delayed");
  await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: harness.tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({
      created_at: new Date(slack.createdAt + 25 * DAY_MS).toISOString(),
      payload,
    }),
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  const after = await state(harness, slack.opportunityId, slack.eventId);
  expect(after.opportunity?.status).toBe("scheduled");
  expect(after.opportunity?.lostReason).toBeUndefined();
  expect(after.row?.opportunityStatus).toBe("scheduled");
  const meetings = await harness.t.run((ctx) => ctx.db.query("meetings").take(5));
  expect(meetings.map((meeting) => meeting.opportunityId)).toEqual([slack.opportunityId]);
});

it("keeps stale expiries out of the pipeline health loss attribution", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  await slackOpportunity(harness, 32);
  // An old deal a closer lost today: found by when it was lost, not its age.
  await harness.t.run(async (ctx) => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", harness.tenantId))
      .take(10);
    const closerId = users.find((user) => user.role === "closer")!._id;
    const leadId = await ctx.db.insert("leads", { ...qualifiedLifecycle(NOW - 60 * DAY_MS),
      tenantId: harness.tenantId,
      status: "active",
      firstSeenAt: NOW - 60 * DAY_MS,
      updatedAt: NOW - 60 * DAY_MS,
    });
    const lostAt = NOW - 60 * 60 * 1000;
    await ctx.db.insert("opportunities", {
      tenantId: harness.tenantId,
      leadId,
      assignedCloserId: closerId,
      ...stageFields("lost", "calendly"),
      lostAt,
      lostByUserId: closerId,
      createdAt: NOW - 60 * DAY_MS,
      updatedAt: lostAt,
      latestActivityAt: lostAt,
    });
  });
  await runCron(harness);

  const report = await harness.admin.query(
    api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
    { startDate: NOW - DAY_MS, endDate: NOW + DAY_MS },
  );

  expect(report.lossAttribution).toMatchObject({ closer: 1, unknown: 0 });
});
