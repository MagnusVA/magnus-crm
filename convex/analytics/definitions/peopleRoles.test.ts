import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { qualifiedLifecycle } from "../../../tests/bookingHarness";
import { expectSameAnswer, rowFromDoc } from "../../../tests/analyticsParity";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { businessDayStart, DEFAULT_BUSINESS_DAY } from "../../../lib/businessDay";
import { loadCreditFacts, summarizeCaptures, type PeopleRole } from "../../reports/lib/creditFacts";
import { mergeAttributionLanes, mergeAttributionPaths } from "../merge/attribution";
import { mergeSetters, mergeDmClosers, mergeLeadGen } from "../merge/peopleRoles";
import { attributionReports } from "./attribution";
import { peopleRoleReports } from "./peopleRoles";

// The lead owns registry wiring. Exercise the existing parity harness with
// these definitions registered only inside this test module.
vi.mock("../registry", async () => {
  const { attributionReports } = await import("./attribution");
  const { peopleRoleReports } = await import("./peopleRoles");
  const definitions = [...attributionReports, ...peopleRoleReports];
  return { getReportDefinition: (id: string) => {
    const definition = definitions.find(d => d.id === id);
    if (!definition) throw new Error(`Unknown report ${id}`);
    return definition;
  } };
});

const DAY = 86_400_000;
const from = businessDayStart("2026-09-28", DEFAULT_BUSINESS_DAY);
const split = from + DAY, to = split + DAY;
const range = { fromMs: from, toMs: to, startDate: "2026-09-28", endDateInclusive: "2026-09-29", ...DEFAULT_BUSINESS_DAY };
const identity = { subject: "admin", org_id: "org_c" };

async function createFixture() {
  const t = convexTest({ schema, modules: convexTestModules, transactionLimits: true });
  const fixture = await t.run(async ctx => {
    const tenantId = await ctx.db.insert("tenants", { companyName: "Reports", contactEmail: "reports@example.invalid",
      workosOrgId: "org_c", status: "active", inviteExpiresAt: to, createdBy: "test" });
    const memberA = await ctx.db.insert("teamMembers", { tenantId, displayName: "A", createdAt: 0, updatedAt: 0 });
    const memberB = await ctx.db.insert("teamMembers", { tenantId, displayName: "B", createdAt: 0, updatedAt: 0 });
    const memberIdle = await ctx.db.insert("teamMembers", { tenantId, displayName: "Idle", createdAt: 0, updatedAt: 0 });
    const admin = await ctx.db.insert("users", { tenantId, workosUserId: "admin", email: "admin@example.invalid", role: "tenant_admin", isActive: true });
    const closerA = await ctx.db.insert("users", { tenantId, workosUserId: "a", email: "a@example.invalid", role: "closer", isActive: true, teamMemberId: memberA });
    const closerB = await ctx.db.insert("users", { tenantId, workosUserId: "b", email: "b@example.invalid", role: "lead_generator", isActive: true, teamMemberId: memberB });
    const teamId = await ctx.db.insert("attributionTeams", { tenantId, slug: "team", displayName: "DM team", utmSource: "team",
      normalizedUtmSource: "team", isActive: true, createdAt: 0, updatedAt: 0 });
    const programId = await ctx.db.insert("tenantPrograms", { tenantId, name: "Program", normalizedName: "program", createdAt: 0, updatedAt: 0, createdByUserId: admin });
    const leadId = await ctx.db.insert("leads", { tenantId, fullName: "Person", ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0 });
    const dealId = await ctx.db.insert("opportunities", { tenantId, leadId, stage: "closed", outcome: "won", firstBookedAt: from,
      assignedCloserId: closerB, createdAt: from - DAY, updatedAt: to });
    const installationId = await ctx.db.insert("slackInstallations", { tenantId, teamId: "T", teamName: "Team", isEnterpriseInstall: false,
      appId: "A", botUserId: "BOT", botAccessToken: "test", scopes: [], installedByWorkosUserId: "admin", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "test", status: "active" });
    const workerA = await ctx.db.insert("leadGenWorkers", { tenantId, userId: closerA, workosUserId: "a", email: "a@example.invalid", teamId,
      teamMemberId: memberA, isActive: true, createdAt: 0, updatedAt: 0 });
    const workerB = await ctx.db.insert("leadGenWorkers", { tenantId, userId: closerB, workosUserId: "b", email: "b@example.invalid", teamId,
      teamMemberId: memberB, isActive: false, createdAt: 0, updatedAt: 0 });
    for (const [slackUserId, member] of [["UA", memberA], ["UB", memberB], ["UI", memberIdle], ["UNLINKED", undefined]] as const) {
      await ctx.db.insert("slackUsers", { tenantId, installationId, slackUserId, slackTeamId: "T", teamMemberId: member,
        isBot: false, isDeleted: false, firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0 });
    }
    const dmA = await ctx.db.insert("dmClosers", { tenantId, teamId, slug: "a", displayName: "A", utmMedium: "a",
      normalizedUtmMedium: "a", isActive: true, createdAt: 0, updatedAt: 0, teamMemberId: memberA });
    const meeting = (fields: Partial<Doc<"meetings">> = {}) => ctx.db.insert("meetings", {
      tenantId, opportunityId: dealId, assignedCloserId: closerB, calendlyEventUri: "event", calendlyInviteeUri: "invitee",
      scheduledAt: from + 3_600_000, durationMinutes: 30, status: "held", createdAt: from + 100, ...fields });
    const meetingA = await meeting();
    const meetingB = await meeting({ createdAt: split + 100, scheduledAt: split + 3_600_000, status: "no_show" });
    const replacement = await meeting({ createdAt: split + 200, scheduledAt: to + DAY, status: "scheduled", rescheduledFromMeetingId: meetingB });
    const teamOnly = await meeting({ createdAt: split + 300, status: "scheduled", scheduledAt: from + 3_600_000 });
    const moved = await meeting({ status: "canceled", createdAt: from + 50 });
    await meeting({ rescheduledFromMeetingId: moved, createdAt: split + 400 });
    const prospectId = await ctx.db.insert("leadGenProspects", { tenantId, firstSource: "instagram", latestSource: "instagram", dedupeKey: "person",
      normalizedHandle: "person", rawHandle: "person", profileUrl: "url", firstCapturedByWorkerId: workerA, firstCapturedAt: from,
      lastSubmittedByWorkerId: workerA, lastSubmittedAt: split, latestOriginKind: "follower", contactAttemptCount: 2,
      distinctWorkerCount: 1, leadId, createdAt: from, updatedAt: split });
    const eventId = await ctx.db.insert("domainEvents", { tenantId, entityType: "lead", entityId: leadId, eventType: "lead.captured", occurredAt: from, source: "system" });
    const batchId = await ctx.db.insert("resparkBatches", { tenantId, userId: closerA, workerId: workerA, createdAt: from, heldUntil: to, size: 1, requestedSize: 1 });
    const itemId = await ctx.db.insert("resparkBatchItems", { tenantId, batchId, userId: closerA, workerId: workerA, leadId,
      position: 0, bucket: 1, heldUntil: to, result: "resparked", workedAt: split + 500 });
    // Worked without a respark: they don't count as resparks.
    for (const result of ["skipped", "not_a_fit"] as const) {
      await ctx.db.insert("resparkBatchItems", { tenantId, batchId, userId: closerA, workerId: workerA, leadId,
        position: 1, bucket: 1, heldUntil: to, result, workedAt: split + 600 });
    }
    const credit = (fields: Pick<Doc<"dealAttributions">, "role" | "source"> & Partial<Doc<"dealAttributions">>) =>
      ctx.db.insert("dealAttributions", { tenantId, opportunityId: dealId, teamMemberId: memberA, attributedAt: from, createdAt: from, ...fields });
    await credit({ role: "lead_gen", source: { kind: "capture", prospectId, workerId: workerA, eventId } });
    await credit({ role: "lead_gen", teamMemberId: memberB, source: { kind: "capture", prospectId, workerId: workerB, eventId } });
    await credit({ role: "lead_gen", attributedAt: split + 500, source: { kind: "respark", itemId, workerId: workerA, eventId } });
    await credit({ role: "setter", source: { kind: "slack_qualification", slackUserId: "UA" } });
    await credit({ role: "setter", attributedAt: split + 10, source: { kind: "slack_qualification", slackUserId: "UA" } });
    await credit({ role: "setter", teamMemberId: memberB, attributedAt: split + 10, source: { kind: "slack_qualification", slackUserId: "UB" } });
    await credit({ role: "setter", teamMemberId: undefined, source: { kind: "slack_qualification", slackUserId: "UNLINKED" } });
    for (const id of [meetingA, meetingB, replacement]) {
      const doc = (await ctx.db.get("meetings", id))!;
      await credit({ role: "dm_closer", meetingId: id, attributedAt: doc.createdAt, source: { kind: "booking_utm", dmCloserId: dmA } });
    }
    await credit({ role: "dm_team", meetingId: teamOnly, teamMemberId: undefined, teamId, attributedAt: split + 300, source: { kind: "booking_utm" } });
    await credit({ role: "dm_team", meetingId: meetingA, teamMemberId: undefined, teamId, attributedAt: from + 100, source: { kind: "booking_utm" } });
    await credit({ role: "closer", meetingId: meetingA, source: { kind: "booking_closer", userId: closerA } });
    await credit({ role: "closer", teamMemberId: memberB, meetingId: meetingB, source: { kind: "reassignment", userId: closerB }, attributedAt: split });
    // A credit after all payments still belongs in the chain, with zero cash.
    await credit({ role: "closer", teamMemberId: memberIdle, source: { kind: "booking_closer", userId: admin }, attributedAt: to });
    const pay = (fields: Partial<Doc<"paymentRecords">> = {}) => ctx.db.insert("paymentRecords", {
      tenantId, opportunityId: dealId, attributedCloserId: closerB, amountMinor: 10000, currency: "USD", recordedByUserId: admin,
      programId, programName: "Program", paymentType: "deposit", status: "recorded", recordedAt: from + 1000, origin: "admin_meeting", ...fields });
    await pay();
    await pay({ recordedAt: split + 1000, amountMinor: 20000, paymentType: "split" });
    await pay({ recordedAt: split + 2000, currency: "EUR", amountMinor: 7000, paymentType: "pif" });
    await pay({ recordedAt: from + 2000, status: "disputed", amountMinor: 999999 });
    for (const at of [from + 100, split + 100]) {
      await ctx.db.insert("slackQualificationEvents", { tenantId, installationId, leadId, opportunityId: dealId, slackUserId: "UA", slackTeamId: "T",
        qualifiedBy: { slackUserId: "UA", slackTeamId: "T", submittedAt: at }, fullNameSnapshot: "Person", resultKind: at < split ? "created_opportunity" : "duplicate_pending",
        platform: "instagram", handleSnapshot: "person", submittedAt: at, createdAt: at });
      await ctx.db.insert("leadGenSubmissions", { tenantId, prospectId, workerId: workerA, userId: closerA, teamId, source: "instagram",
        originKind: "follower", originRankable: false, submittedAt: at, createdAt: at });
    }
    await ctx.db.insert("leadGenSubmissions", { tenantId, prospectId, workerId: workerA, userId: closerA, source: "instagram",
      originKind: "follower", originRankable: false, submittedAt: from + 200, createdAt: from, voidedAt: split });
    for (const weekday of ["monday", "tuesday"] as const) {
      await ctx.db.insert("slackQualifierSchedules", { tenantId, slackUserId: "UA", weekday, scheduledHours: 8, updatedByUserId: admin, updatedAt: 0 });
      await ctx.db.insert("slackQualifierSchedules", { tenantId, slackUserId: "UA", weekday, effectiveFrom: "2026-09-29", scheduledHours: 6, updatedByUserId: admin, updatedAt: split });
      await ctx.db.insert("dmCloserSchedules", { tenantId, dmCloserId: dmA, weekday, scheduledHours: 5, updatedByUserId: admin, updatedAt: 0 });
      await ctx.db.insert("leadGenWorkerSchedules", { tenantId, workerId: workerA, userId: closerA, weekday, scheduledHours: 4, updatedByUserId: admin, updatedAt: 0 });
    }
    return { tenantId, memberA, memberB, memberIdle, dealId, meetingA, meetingB, moved, teamId, admin, closerA, closerB };
  });
  return { t, ...fixture };
}

async function warehouseRows(fixture: Awaited<ReturnType<typeof createFixture>>, role?: PeopleRole, memberId: Id<"teamMembers"> | null = null) {
  const facts = await fixture.t.run(ctx => loadCreditFacts(ctx, fixture.tenantId, range, role));
  const detail = role !== "lead_gen" || memberId !== null;
  return {
    payments: facts.payments.filter(p => p.status !== "disputed").map(p => rowFromDoc("paymentRecords", p)),
    attributions: facts.attributions.map(p => rowFromDoc("dealAttributions", p)),
    deals: facts.deals.map(p => rowFromDoc("opportunities", p)), meetings: facts.meetings.map(p => rowFromDoc("meetings", p)),
    firstPayments: facts.firstPayments.map(p => rowFromDoc("paymentRecords", p)),
    qualifications: facts.qualifications.map(p => rowFromDoc("slackQualificationEvents", p)),
    captures: detail ? facts.captures.filter(p => p.voidedAt === undefined).map(p => rowFromDoc("leadGenSubmissions", p)) : [],
    prospects: detail ? facts.prospects.map(p => rowFromDoc("leadGenProspects", p)) : [],
    resparks: facts.resparks.map(p => rowFromDoc("resparkBatchItems", p)), people: detail ? facts.people.map(p => rowFromDoc("leads", p)) : [],
    ...(role === "lead_gen" ? { captureStats: summarizeCaptures(facts, range).map(stat => ({
      worker_id: stat.workerId, lead_id: stat.leadId, day_key: stat.dayKey, captures: stat.captures,
    })) } : {}),
  };
}

const peopleCases = [
  { id: "people.setters", role: "setter", live: api.reports.peopleRoles.getSetters, merge: mergeSetters },
  { id: "people.dm_closers", role: "dm_closer", live: api.reports.peopleRoles.getDmClosers, merge: mergeDmClosers },
  { id: "people.lead_gen", role: "lead_gen", live: api.reports.peopleRoles.getLeadGen, merge: mergeLeadGen },
] as const;
const attributionCases = [
  { id: "attribution.lanes", live: api.reports.attribution.getLanes, merge: mergeAttributionLanes },
  { id: "attribution.paths", live: api.reports.attribution.getPaths, merge: mergeAttributionPaths },
] as const;

describe("new report parity and merges", () => {
  for (const report of [...attributionCases, ...peopleCases]) {
    it(`${report.id} has warehouse parity`, async () => {
      const fixture = await createFixture();
      await expectSameAnswer({ t: fixture.t, identity, tenantId: fixture.tenantId, range, reportId: report.id,
        live: report.live, liveArgs: { startDate: from, endDate: to }, filters: "role" in report ? { memberId: null } : {},
        rows: await warehouseRows(fixture, "role" in report ? report.role : undefined) });
    });
  }
  for (const report of peopleCases) {
    it(`${report.id} merges deals, days, items, people and schedules across two payments`, async () => {
      const fixture = await createFixture();
      const args = { memberId: fixture.memberA };
      const result = await expectMergedAnswer({ t: fixture.t, identity, live: report.live,
        history: { ...args, startDate: from, endDate: split }, today: { ...args, startDate: split, endDate: to },
        whole: { ...args, startDate: from, endDate: to }, merge: report.merge });
      expect(result.whole.rows[0].dealIds).toEqual([fixture.dealId]);
      expect(result.whole.rows[0].byCurrency).toEqual([{ currency: "EUR", amountMinor: 7000 }, { currency: "USD", amountMinor: 30000 }]);
      await expectSameAnswer({ t: fixture.t, identity, tenantId: fixture.tenantId, range, reportId: report.id,
        live: report.live, liveArgs: { ...args, startDate: from, endDate: to }, filters: args, rows: await warehouseRows(fixture, report.role, fixture.memberA) });
    });
  }
  it("attribution.lanes merges split payments and distinct deal IDs", async () => {
    const fixture = await createFixture();
    await expectMergedAnswer({ t: fixture.t, identity, live: api.reports.attribution.getLanes,
      history: { startDate: from, endDate: split }, today: { startDate: split, endDate: to },
      whole: { startDate: from, endDate: to }, merge: mergeAttributionLanes });
  });
  it("attribution.paths merges a path paid in both windows", async () => {
    const fixture = await createFixture();
    const result = await expectMergedAnswer({ t: fixture.t, identity, live: api.reports.attribution.getPaths,
      history: { startDate: from, endDate: split }, today: { startDate: split, endDate: to },
      whole: { startDate: from, endDate: to }, merge: mergeAttributionPaths });
    expect(result.history.paths[0].key).toBe(result.today.paths[0].key);
    expect(result.whole.paths[0].dealIds).toEqual([fixture.dealId]);
  });
});

describe("credit and role facts", () => {
  it("credits two humans in full, deduplicates rows, honors time and closer ownership, and separates currencies", async () => {
    const f = await createFixture();
    const result = await f.t.withIdentity(identity).query(api.reports.attribution.getLanes, { startDate: from, endDate: to });
    expect(result.totals).toEqual([
      { currency: "EUR", cashMinor: 7000, finalMinor: 7000, payments: 1 },
      { currency: "USD", cashMinor: 30000, finalMinor: 20000, payments: 2 },
    ]);
    const lane = (role: string) => result.lanes.find(lane => lane.role === role)!;
    expect(lane("lead_gen").byCurrency).toEqual([
      { currency: "EUR", laneMinor: 7000, sharedMinor: 7000, coverage: 1 }, { currency: "USD", laneMinor: 30000, sharedMinor: 30000, coverage: 1 },
    ]);
    expect(lane("lead_gen").people).toHaveLength(2);
    expect(lane("setter").people.find(p => p.teamMemberId === f.memberA)?.byCurrency.find(c => c.currency === "USD")?.amountMinor).toBe(30000);
    expect(lane("setter").people.find(p => p.teamMemberId === f.memberB)?.byCurrency.find(c => c.currency === "USD")?.amountMinor).toBe(20000);
    expect(lane("setter").people.find(p => !p.linked)?.name).toBe("Not linked to a member");
    expect(lane("closer").people.map(p => p.teamMemberId)).toEqual([f.memberB]);
    expect(lane("closer").byCurrency.every(c => c.sharedMinor === 0)).toBe(true);
    expect(lane("lead_gen").dealIds).toEqual([f.dealId]);
    for (const total of result.totals) {
      for (const current of result.lanes) {
        const credited = current.byCurrency.find(c => c.currency === total.currency)!.laneMinor;
        const missing = result.uncreditedByRole.find(c => c.role === current.role)!.byCurrency.find(c => c.currency === total.currency)!.amountMinor;
        expect(credited + missing).toBe(total.cashMinor);
      }
    }
  });
  it("retains all chain contributors, zero cash, historical meeting closers and moved/rebooked meetings", async () => {
    const f = await createFixture();
    const chain = await f.t.withIdentity(identity).query(api.reports.attribution.getDealChain, { opportunityId: f.dealId });
    expect(chain.personName).toBe("Person");
    expect(chain.credits.find(c => c.teamMemberId === f.memberIdle)?.creditedFor.every(c => c.amountMinor === 0)).toBe(true);
    expect(chain.credits.find(c => c.role === "closer" && c.teamMemberId === f.memberA)?.creditedFor.every(c => c.amountMinor === 0)).toBe(true);
    expect(chain.meetings.find(m => m.id === f.meetingA)?.closer.teamMemberId).toBe(f.memberA);
    expect(chain.meetings.find(m => m.id === f.moved)?.moved).toBe(true);
    expect(chain.meetings.some(m => m.rebooked)).toBe(true);
    expect(chain.payments).toHaveLength(4);
  });
  it("counts setter cohorts, dated schedules, nonreplacement DM bookings and unique captured people", async () => {
    const f = await createFixture();
    const reader = f.t.withIdentity(identity), args = { startDate: from, endDate: to };
    const setters = await reader.query(api.reports.peopleRoles.getSetters, args);
    const setter = setters.rows.find(r => r.teamMemberId === f.memberA)!;
    expect(setter).toMatchObject({ qualifications: 2, qualificationsByResult: { created_opportunity: 1, duplicate_pending: 1 },
      dealsCredited: 1, booked: 1, held: 1, won: 1, scheduledHours: 14, bookRate: { numerator: 1, denominator: 1, rate: 1 } });
    expect(setters.rows.some(r => r.teamMemberId === f.memberIdle && r.qualifications === 0)).toBe(true);
    const dm = await reader.query(api.reports.peopleRoles.getDmClosers, args);
    expect(dm.rows.find(r => r.teamMemberId === f.memberA)).toMatchObject({ bookings: 2, held: 1, noShow: 1, dealsWon: 1, scheduledHours: 10 });
    expect(dm.rows.find(r => r.teamId === f.teamId)).toMatchObject({ bookings: 1, notRecorded: 1 });
    const gen = await reader.query(api.reports.peopleRoles.getLeadGen, args);
    expect(gen.rows.find(r => r.teamMemberId === f.memberA)).toMatchObject({ captures: 2, uniquePeople: 1, resparks: 1, dealsCredited: 1,
      dealsWon: 1, scheduledHours: 8, dealsCreditedBySource: { capture: 1, respark: 1 } });
  });
  it("keeps uncredited cash in coverage and recomputes coverage after merging", async () => {
    const f = await createFixture();
    await f.t.run(async ctx => {
      const payment = (await ctx.db.query("paymentRecords").first())!;
      const { _id: _paymentId, _creationTime: _created, ...fields } = payment;
      await ctx.db.insert("paymentRecords", { ...fields, opportunityId: undefined, attributedCloserId: undefined,
        status: "recorded", amountMinor: 30000, recordedAt: split + 5000 });
    });
    const { whole } = await expectMergedAnswer({ t: f.t, identity, live: api.reports.attribution.getLanes,
      history: { startDate: from, endDate: split }, today: { startDate: split, endDate: to },
      whole: { startDate: from, endDate: to }, merge: mergeAttributionLanes });
    for (const lane of whole.lanes) expect(lane.byCurrency.find(c => c.currency === "USD")?.coverage).toBe(0.5);
    expect(whole.uncreditedByRole.every(role => role.byCurrency.find(c => c.currency === "USD")?.amountMinor === 30000)).toBe(true);
  });
  it("uses payment-time paths and leaves a role added after a payment out of its path", async () => {
    const f = await createFixture();
    await f.t.run(async ctx => {
      const credits = await ctx.db.query("dealAttributions").take(100);
      for (const credit of credits.filter(c => c.role === "setter")) await ctx.db.patch("dealAttributions", credit._id, { attributedAt: split + 100 });
    });
    const paths = await f.t.withIdentity(identity).query(api.reports.attribution.getPaths, { startDate: from, endDate: to });
    expect(paths.paths.find(p => !p.roles.includes("setter"))?.byCurrency).toEqual([{ currency: "USD", amountMinor: 10000 }]);
    expect(paths.paths.find(p => p.roles.includes("setter"))?.byCurrency).toEqual([{ currency: "EUR", amountMinor: 7000 }, { currency: "USD", amountMinor: 20000 }]);
  });
  it("excludes deals whose first non-disputed payment predates the range from new wins", async () => {
    const f = await createFixture();
    await f.t.run(async ctx => {
      const payment = (await ctx.db.query("paymentRecords").first())!;
      const { _id: _paymentId, _creationTime: _created, ...fields } = payment;
      await ctx.db.insert("paymentRecords", { ...fields, recordedAt: from - DAY, status: "verified" });
    });
    for (const report of peopleCases.filter(report => report.role !== "setter")) {
      const result = await f.t.withIdentity(identity).query(report.live, { startDate: from, endDate: to });
      expect(result.rows.every(row => row.dealsWon === 0)).toBe(true);
    }
  });
  it("credits a team-only DM deal's cash to its team row", async () => {
    const f = await createFixture();
    await f.t.run(async ctx => {
      for (const credit of await ctx.db.query("dealAttributions").take(100)) {
        if (credit.role === "dm_closer") await ctx.db.delete("dealAttributions", credit._id);
      }
    });
    const result = await f.t.withIdentity(identity).query(api.reports.peopleRoles.getDmClosers, { startDate: from, endDate: to });
    expect(result.rows.find(row => row.teamId === f.teamId)).toMatchObject({ bookings: 2, dealsWon: 1,
      byCurrency: [{ currency: "EUR", amountMinor: 7000 }, { currency: "USD", amountMinor: 30000 }] });
  });
  it("caps member items after sorting and keeps that cap through a split range", async () => {
    const f = await createFixture();
    await f.t.run(async ctx => {
      const qualification = (await ctx.db.query("slackQualificationEvents").first())!;
      const { _id: _qualificationId, _creationTime: _created, ...fields } = qualification;
      for (let i = 0; i < 301; i++) await ctx.db.insert("slackQualificationEvents", {
        ...fields, submittedAt: i % 2 ? from + 3000 + i : split + 3000 + i,
      });
    });
    const args = { memberId: f.memberA };
    const { whole } = await expectMergedAnswer({ t: f.t, identity, live: api.reports.peopleRoles.getSetters,
      history: { ...args, startDate: from, endDate: split }, today: { ...args, startDate: split, endDate: to },
      whole: { ...args, startDate: from, endDate: to }, merge: mergeSetters });
    expect(whole.items).toHaveLength(300);
    expect(whole.items[0].at).toBe(split + 3300);
    expect(whole.rows[0].qualifications).toBe(303);
  });
  it("returns empty money and paths for an empty range", async () => {
    const f = await createFixture();
    const args = { startDate: to + DAY, endDate: to + 2 * DAY };
    const lanes = await f.t.withIdentity(identity).query(api.reports.attribution.getLanes, args);
    expect(lanes.totals).toEqual([]);
    expect(lanes.lanes.every(lane => lane.people.length === 0 && lane.byCurrency.length === 0)).toBe(true);
    expect(await f.t.withIdentity(identity).query(api.reports.attribution.getPaths, args)).toEqual({ paths: [], isTruncated: false });
  });
  it("keeps a slot moved when its successor was moved to another deal", async () => {
    const f = await createFixture();
    await f.t.run(async ctx => {
      const original = (await ctx.db.get("opportunities", f.dealId))!;
      const { _id: _dealId, _creationTime: _created, ...fields } = original;
      const otherDealId = await ctx.db.insert("opportunities", fields);
      const successor = (await ctx.db.query("meetings").withIndex("by_rescheduledFromMeetingId", q => q.eq("rescheduledFromMeetingId", f.moved)).first())!;
      await ctx.db.patch("meetings", successor._id, { opportunityId: otherDealId });
    });
    const chain = await f.t.withIdentity(identity).query(api.reports.attribution.getDealChain, { opportunityId: f.dealId });
    expect(chain.meetings.find(meeting => meeting.id === f.moved)?.moved).toBe(true);
    expect(chain.meetings).toHaveLength(5);
  });
});

describe("member access and SQL contracts", () => {
  it("forces the viewer's own member and refuses another member in queries and parseFilters", async () => {
    const f = await createFixture();
    for (const report of peopleCases) {
      const result = await f.t.withIdentity({ subject: "a", org_id: "org_c" }).query(report.live, { startDate: from, endDate: to });
      expect(result.memberId).toBe(f.memberA);
      expect(result.rows.every(r => r.teamMemberId === f.memberA)).toBe(true);
      await expect(f.t.withIdentity({ subject: "a", org_id: "org_c" }).query(report.live, { startDate: from, endDate: to, memberId: f.memberB })).rejects.toThrow("own report");
    }
    await f.t.run(async ctx => {
      const viewer = { userId: f.closerA, tenantId: f.tenantId, role: "closer" as const, workosUserId: "a" };
      for (const definition of peopleRoleReports) {
        expect(await definition.parseFilters(ctx, {}, viewer)).toEqual({ memberId: f.memberA });
        await expect(definition.parseFilters(ctx, { memberId: f.memberB }, viewer)).rejects.toThrow("own report");
        expect(await definition.parseFilters(ctx, {}, { ...viewer, userId: f.admin, role: "tenant_admin" })).toEqual({ memberId: null });
      }
    });
    await expect(f.t.withIdentity({ subject: "a", org_id: "org_c" }).query(api.reports.attribution.getDealChain, { opportunityId: f.dealId })).rejects.toThrow("Insufficient permissions");
  });
  it("rejects another tenant's member and deal, and a viewer without a linked member", async () => {
    const f = await createFixture();
    const foreign = await f.t.run(async ctx => {
      const tenantId = await ctx.db.insert("tenants", { companyName: "Other", contactEmail: "other@example.invalid",
        workosOrgId: "org_other", status: "active", inviteExpiresAt: to, createdBy: "test" });
      const memberId = await ctx.db.insert("teamMembers", { tenantId, displayName: "Private member", createdAt: 0, updatedAt: 0 });
      const deal = (await ctx.db.get("opportunities", f.dealId))!;
      const { _id: _id, _creationTime: _created, ...fields } = deal;
      const opportunityId = await ctx.db.insert("opportunities", { ...fields, tenantId });
      await ctx.db.insert("users", { tenantId: f.tenantId, role: "closer", email: "unlinked@example.invalid", workosUserId: "unlinked", isActive: true });
      return { memberId, opportunityId };
    });
    for (const report of peopleCases) {
      await expect(f.t.withIdentity(identity).query(report.live, { startDate: from, endDate: to, memberId: foreign.memberId })).rejects.toThrow("Invalid filter");
      await expect(f.t.withIdentity({ subject: "unlinked", org_id: "org_c" }).query(report.live, { startDate: from, endDate: to })).rejects.toThrow("isn't linked");
    }
    await expect(f.t.withIdentity(identity).query(api.reports.attribution.getDealChain, { opportunityId: foreign.opportunityId })).rejects.toThrow("Deal not found");
    await f.t.run(async ctx => {
      for (const definition of peopleRoleReports) await expect(definition.parseFilters(ctx, { memberId: foreign.memberId }, {
        tenantId: f.tenantId, userId: f.admin, role: "tenant_admin", workosUserId: "admin",
      })).rejects.toThrow("Invalid filter");
    });
  });
  for (const definition of [...attributionReports, ...peopleRoleReports]) {
    it(`${definition.id} filters every view by tenant and parameterizes every value`, () => {
      const queries = definition.sql({ tenantId: "TENANT_SENTINEL" as Doc<"tenants">["_id"], range,
        filters: { memberId: "FILTER_SENTINEL" } });
      for (const query of Object.values(queries)) {
        const views = query.sql.match(/\banalytics\.(?!watermark\b)\w+/g) ?? [];
        const tenantFilters = query.sql.match(/\btenant_id\s*=\s*\{tenant_id:String\}/g) ?? [];
        expect(views.length).toBeGreaterThan(0);
        expect(tenantFilters.length).toBeGreaterThanOrEqual(views.length);
        expect(query.sql).not.toMatch(/convex_app\.|FILTER_SENTINEL|TENANT_SENTINEL/);
        expect(query.params).not.toHaveProperty("tenant_id");
        expect(query.params).toMatchObject({ from_ms: from, to_ms: to, tz: DEFAULT_BUSINESS_DAY.timeZone, day_start_hour: 1 });
      }
    });
  }
});
