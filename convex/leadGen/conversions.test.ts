/**
 * Prospect conversion by lead gen worker (docs/plans/phase-2-person-first.md
 * §7), and its Deals column (docs/plans/phase-3-attribution.md §6.6).
 */
import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness } from "../../tests/bookingHarness";
import { recordDealCreation } from "../lib/attribution/dealAttributions";
import { CONVERSION_DEALS_READ_LIMIT } from "./conversions";
import { deleteLeadGenDealAggregate } from "./leadGenDealsAggregate";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;
type Caller = Harness["admin"];

const NOW = Date.parse("2026-10-10T18:00:00Z");
const OCTOBER = { startDayKey: "2026-10-01", endDayKey: "2026-10-31" };
const SEPTEMBER = { startDayKey: "2026-09-01", endDayKey: "2026-09-30" };

async function slackInstallation(h: Harness) {
  return await h.t.run(async (ctx) =>
    await ctx.db.insert("slackInstallations", {
      tenantId: h.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
      appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "r", status: "active",
    }),
  );
}

/** Qualifies a handle in Slack, which creates its deal. Returns the deal. */
async function qualify(
  h: Harness,
  installationId: Id<"slackInstallations">,
  handle: string,
  submittedAt: number,
): Promise<Id<"opportunities">> {
  await h.t.mutation(internal.slack.createQualifiedLead.create, {
    tenantId: h.tenantId, installationId, fullName: "Lead", handle, country: "Honduras", leadType: "pt",
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt },
  });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  return await h.t.run(async (ctx) => {
    const deal = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", h.tenantId))
      .order("desc")
      .first();
    if (!deal) throw new Error("Slack qualification created no deal");
    return deal._id;
  });
}

/** Qualifies a handle, then writes the deal's creation rows (§4.2). */
async function qualifyAndCredit(
  h: Harness,
  installationId: Id<"slackInstallations">,
  handle: string,
  submittedAt: number,
): Promise<Id<"opportunities">> {
  const opportunityId = await qualify(h, installationId, handle, submittedAt);
  await h.t.run((ctx) => recordDealCreation(ctx, opportunityId));
  return opportunityId;
}

function capture(caller: Caller, handle: string) {
  return caller.mutation(api.leadGen.capture.submit, {
    source: "instagram", rawHandleOrProfileUrl: `@${handle}`, originKind: "follower",
  });
}

async function addAdmin(h: Harness, workosUserId: string, email: string): Promise<Caller> {
  await h.t.run(async (ctx) => {
    await ctx.db.insert("users", {
      tenantId: h.tenantId, workosUserId, email, role: "tenant_admin", isActive: true,
    });
  });
  return h.t.withIdentity({ subject: workosUserId, org_id: "org_test" });
}

async function workerIdFor(h: Harness, email: string): Promise<Id<"leadGenWorkers">> {
  return await h.t.run(async (ctx) => {
    const workers = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_isActive", (q) => q.eq("tenantId", h.tenantId))
      .take(10);
    const worker = workers.find((row) => row.email === email);
    if (!worker) throw new Error(`No lead gen worker for ${email}`);
    return worker._id;
  });
}

type Report = Awaited<ReturnType<typeof listConversions>>;

function listConversions(h: Harness, range: { startDayKey: string; endDayKey: string }) {
  return h.admin.query(api.leadGen.conversions.listProspectConversions, range);
}

function byWorker(report: Report) {
  return new Map(report.rows.map((row) => [row.workerId, row]));
}

it("credits each worker's prospects, and only the stages reached after the capture", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW - 3_600_000));
  const h = await bookingHarness();
  const installationId = await slackInstallation(h);

  // Qualified before the capture: the worker gets the prospect only.
  await qualify(h, installationId, "already.qualified", NOW - 7_200_000);
  await capture(h.admin, "already.qualified");
  // Captured, then qualified: the worker gets both.
  await capture(h.admin, "converts.later");
  await capture(h.admin, "stays.prospect");
  vi.setSystemTime(new Date(NOW));
  await qualify(h, installationId, "converts.later", NOW);

  const rows = await listConversions(h, OCTOBER);

  expect(rows.capped).toBe(false);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].counts).toEqual({
    prospect: 3, in_conversation: 1, qualified: 1, booked: 0, showed: 0, customer: 0,
  });
  const outside = await listConversions(h, SEPTEMBER);
  expect(outside).toEqual({ rows: [], capped: false, dealsCapped: false });
});

it("counts each worker's deals from the lead gen rows whose capture falls in the range", async () => {
  vi.useFakeTimers();
  const h = await bookingHarness();
  const second = await addAdmin(h, "user_second", "second@example.com");
  const installationId = await slackInstallation(h);

  // September: the first worker finds someone who qualifies in October.
  vi.setSystemTime(new Date(Date.parse("2026-09-15T18:00:00Z")));
  await capture(h.admin, "first.september");

  // October: Slack reaches this person before the second worker captures them.
  vi.setSystemTime(new Date(NOW - 7_200_000));
  const slackFirstDeal = await qualifyAndCredit(h, installationId, "slack.first", NOW - 7_200_000);

  vi.setSystemTime(new Date(NOW - 3_600_000));
  await capture(h.admin, "first.deal");
  await capture(h.admin, "first.nodeal");
  await capture(second, "second.deal");
  await capture(second, "slack.first");

  vi.setSystemTime(new Date(NOW));
  const septemberDeal = await qualifyAndCredit(h, installationId, "first.september", NOW);
  const firstDeal = await qualifyAndCredit(h, installationId, "first.deal", NOW);
  const secondDeal = await qualifyAndCredit(h, installationId, "second.deal", NOW);

  const firstWorker = await workerIdFor(h, "admin@example.com");
  const secondWorker = await workerIdFor(h, "second@example.com");

  // The fixture: a lead gen row on each deal whose person a capture reached
  // first, crediting that capture's worker, and none on the Slack-first deal.
  const leadGenRows = await h.t.run((ctx) =>
    ctx.db
      .query("dealAttributions")
      .withIndex("by_tenantId_and_role_and_attributedAt", (q) =>
        q.eq("tenantId", h.tenantId).eq("role", "lead_gen"),
      )
      .take(10),
  );
  expect(
    new Map(
      leadGenRows.map((row) => [
        row.opportunityId,
        row.source.kind === "capture" ? row.source.workerId : null,
      ]),
    ),
  ).toEqual(
    new Map([
      [septemberDeal, firstWorker],
      [firstDeal, firstWorker],
      [secondDeal, secondWorker],
    ]),
  );
  expect(leadGenRows.some((row) => row.opportunityId === slackFirstDeal)).toBe(false);

  const october = await listConversions(h, OCTOBER);
  expect(october.capped).toBe(false);
  expect(october.dealsCapped).toBe(false);
  const octoberRows = byWorker(october);
  expect(octoberRows.size).toBe(2);
  expect(octoberRows.get(firstWorker)).toMatchObject({
    counts: { prospect: 2, in_conversation: 1, qualified: 1, booked: 0, showed: 0, customer: 0 },
    deals: 1,
  });
  // The Slack-first person counts as the second worker's prospect, but
  // neither their qualification nor their deal does.
  expect(octoberRows.get(secondWorker)).toMatchObject({
    counts: { prospect: 2, in_conversation: 1, qualified: 1, booked: 0, showed: 0, customer: 0 },
    deals: 1,
  });

  // The September capture's deal counts in September, when it was captured.
  const september = await listConversions(h, SEPTEMBER);
  expect(september.rows).toHaveLength(1);
  expect(september.rows[0]).toMatchObject({
    workerId: firstWorker,
    counts: { prospect: 1, in_conversation: 1, qualified: 1, booked: 0, showed: 0, customer: 0 },
    deals: 1,
  });

  migrationsTest.register(h.t);
  for (const name of ["backfillLeadGenDealsByWorker", "assertLeadGenDealsByWorker"]) {
    await h.t.mutation(internal.migrations.run, { fn: `migrations:${name}` });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  await h.t.mutation(internal.leadGen.leadGenDealsAggregate.markLeadGenDealsByWorkerVerified, {
    tenantId: h.tenantId,
  });
  expect(await listConversions(h, OCTOBER)).toEqual(october);
  expect(await listConversions(h, SEPTEMBER)).toEqual(september);

  // The person counts don't read the rows: without them, only Deals changes.
  await h.t.run(async (ctx) => {
    for (const row of await ctx.db.query("dealAttributions").take(100)) {
      await deleteLeadGenDealAggregate(ctx, row);
      await ctx.db.delete("dealAttributions", row._id);
    }
  });
  const withoutRows = await listConversions(h, OCTOBER);
  expect(withoutRows).toEqual({
    ...october,
    rows: october.rows.map((row) => ({ ...row, deals: 0 })),
  });
});

it("says Deals is partial when the range holds more lead gen rows than one read covers", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW - 3_600_000));
  const h = await bookingHarness();
  const installationId = await slackInstallation(h);
  const { prospectId } = await capture(h.admin, "many.deals");
  vi.setSystemTime(new Date(NOW));
  const opportunityId = await qualify(h, installationId, "many.deals", NOW);
  const workerId = await workerIdFor(h, "admin@example.com");

  // Direct inserts: more rows than the read takes, all in range.
  await h.t.run(async (ctx) => {
    const eventId = (await ctx.db.query("domainEvents").first())!._id;
    for (let index = 0; index <= CONVERSION_DEALS_READ_LIMIT; index += 1) {
      await ctx.db.insert("dealAttributions", {
        tenantId: h.tenantId,
        opportunityId,
        role: "lead_gen",
        source: { kind: "capture", prospectId, workerId, eventId },
        attributedAt: NOW - 3_600_000 + index,
        createdAt: NOW,
      });
    }
  });

  const report = await listConversions(h, OCTOBER);
  expect(report.capped).toBe(false);
  expect(report.dealsCapped).toBe(true);
  expect(report.rows).toHaveLength(1);
  expect(report.rows[0]).toMatchObject({
    workerId,
    counts: { prospect: 1, in_conversation: 1, qualified: 1, booked: 0, showed: 0, customer: 0 },
    deals: CONVERSION_DEALS_READ_LIMIT,
  });
});
