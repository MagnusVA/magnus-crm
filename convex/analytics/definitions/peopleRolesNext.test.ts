import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { PeopleRoleReport } from "../../reports/peopleRoles";
import { loadCreditFacts } from "../../reports/lib/creditFacts";
import { expectSameAnswer, rowFromDoc, orderedLimitByRows, withOpaquePaymentIds } from "../../../tests/analyticsParity";
import { roleAggregateRows } from "../../../tests/peopleRolesAggregateFixtures";
import { createRoleFixture, DAY, from, split, to, range, identity } from "../../../tests/peopleRolesFixtures";
import { peopleLeadGenNext, peopleSettersNext, peopleDmClosersNext } from "./peopleRolesNext";
import { getReportDefinition, listReportDefinitions } from "../registry";
import { REPORT_PANELS } from "../../mcp/reports/catalog";
import { mergePeopleRoles } from "../merge/peopleRoles";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(to + DAY); });
afterEach(() => vi.useRealTimers());
const cases = [{ definition: peopleDmClosersNext, role: "dm_closer", live: api.reports.peopleRoles.getDmClosers }, { definition: peopleSettersNext, role: "setter", live: api.reports.peopleRoles.getSetters }, { definition: peopleLeadGenNext, role: "lead_gen", live: api.reports.peopleRoles.getLeadGen }] as const;
for (const { definition, role, live } of cases) describe(definition.id, () => {
  it("is dormant and requires context before SQL", async () => {
    expect(definition.page).toBeNull();
    expect(getReportDefinition(definition.id)).toBe(definition);
    expect(listReportDefinitions().map(d => d.id)).not.toContain(definition.id);
    expect(Object.values(REPORT_PANELS).flat()).not.toContain(definition.id);
    expect(definition.node?.keys).toBeUndefined();
    const f = await createRoleFixture();
    const input = { tenantId: f.tenantId, range, filters: { memberId: f.memberA } };
    expect(() => definition.sql(input)).toThrow("context must load");
    const context = await f.t.run(ctx => definition.node!.context(ctx, input, []));
    const queries = definition.sql(input, context);
    for (const q of Object.values(queries)) {
      expect(q.sql.match(/tenant_id = \{tenant_id:String\}/g)?.length).toBeGreaterThanOrEqual(q.sql.match(/\banalytics\.\w+/g)?.length ?? 0);
      expect(q.params).not.toHaveProperty("tenant_id");
      expect(q.params?.worker_members).toContain(f.memberA);
      expect(q.sql).not.toContain(f.memberA);
    }
    expect(queries.cash.sql).toContain("INNER ALL JOIN credits");
    expect(queries.cash.sql).toContain("SELECT DISTINCT payment_id");
    expect(queries.items.sql).toMatch(/WHERE identity_key = \{member_key:String\} ORDER BY at_ms DESC, id ASC LIMIT 300/);
  });
  it("matches live with collapsed workers, unknown identities, duplicate credits, payment timing and stored currency case", async () => {
    const f = await createRoleFixture();
    await f.t.run(async ctx => {
      const worker = (await ctx.db.get("leadGenWorkers", f.workerA))!;
      const { _id, _creationTime, ...fields } = worker; void _id; void _creationTime;
      const second = await ctx.db.insert("leadGenWorkers", { ...fields });
      const c = (await ctx.db.query("leadGenSubmissions").first())!;
      const { _id: cid, _creationTime: cc, ...capture } = c; void cid; void cc;
      await ctx.db.insert("leadGenSubmissions", { ...capture, workerId: second });
      const credit = (await ctx.db.query("dealAttributions").take(100)).find(c => c.role === role)!;
      const { _id: aid, _creationTime: ac, ...a } = credit; void aid; void ac;
      await ctx.db.insert("dealAttributions", a);
      // Two nonexistent members resolve to one unlinked identity.
      const unknowns = await Promise.all(["one", "two"].map(displayName => ctx.db.insert("teamMembers", { tenantId: f.tenantId, displayName, createdAt: 0, updatedAt: 0 })));
      for (const id of unknowns) {
        await ctx.db.delete("teamMembers", id);
        const wid = await ctx.db.insert("leadGenWorkers", { ...fields, teamMemberId: id });
        await ctx.db.insert("leadGenSubmissions", { ...capture, workerId: wid });
        await ctx.db.insert("dealAttributions", { ...a, teamMemberId: id });
      }
      const p = (await ctx.db.query("paymentRecords").first())!;
      const { _id: pid, _creationTime: pc, ...payment } = p; void pid; void pc;
      await ctx.db.insert("paymentRecords", { ...payment, currency: "usd", amountMinor: 123 });
      await ctx.db.insert("paymentRecords", { ...payment, recordedAt: from - 1, amountMinor: 999 });
    });
    for (const memberId of [null, f.memberA, f.memberB, f.memberIdle]) {
      const rows = await roleAggregateRows(f.t, f.tenantId, role, memberId, range, to + DAY);
      // ClickHouse may encode UInt64/Int64 as strings.
      rows.cash.forEach(r => { r.amount_minor = String(r.amount_minor); });
      const answer: PeopleRoleReport = await expectSameAnswer({ t: f.t, identity, tenantId: f.tenantId, range,
        reportId: definition.id, live, liveArgs: { startDate: from, endDate: to, ...(memberId ? { memberId } : {}) }, filters: { memberId }, rows });
      if (!memberId && role === "lead_gen") {
        expect(answer.rows.find(r => r.teamMemberId === f.memberA)).toMatchObject({ captures: 3, uniquePeople: 1, scheduledHours: 8 });
        expect(answer.rows.find(r => r.key === "unlinked")).toMatchObject({ captures: 2, uniquePeople: 1 });
      }
    }
  });
  it("merges warehouse history and one- or two-day live tails exactly", async () => {
    const f = await createRoleFixture();
    await f.t.run(async ctx => {
      const payment = (await ctx.db.query("paymentRecords").first())!;
      const { _id: pid, _creationTime: pc, ...p } = payment; void pid; void pc;
      await ctx.db.insert("paymentRecords", { ...p, recordedAt: to + 100, currency: "usd" });
      if (role === "lead_gen") {
        const capture = (await ctx.db.query("leadGenSubmissions").first())!;
        const { _id, _creationTime, ...c } = capture; void _id; void _creationTime;
        await ctx.db.insert("leadGenSubmissions", { ...c, submittedAt: to + 100 });
        await ctx.db.insert("leadGenWorkerSchedules", { tenantId: f.tenantId, workerId: f.workerA, userId: f.closerA,
          weekday: "wednesday", scheduledHours: 7, updatedByUserId: f.admin, updatedAt: 0 });
      } else if (role === "setter") {
        const qualification = (await ctx.db.query("slackQualificationEvents").first())!;
        const { _id, _creationTime, ...q } = qualification; void _id; void _creationTime;
        await ctx.db.insert("slackQualificationEvents", { ...q, submittedAt: to + 100 });
        await ctx.db.insert("slackQualifierSchedules", { tenantId: f.tenantId, slackUserId: "UA", weekday: "wednesday",
          scheduledHours: 7, updatedByUserId: f.admin, updatedAt: 0 });
      } else {
        const meeting = (await ctx.db.get("meetings", f.meetingA))!;
        const { _id, _creationTime, ...m } = meeting; void _id; void _creationTime;
        const meetingId = await ctx.db.insert("meetings", { ...m, createdAt: to + 100, scheduledAt: to + 1000 });
        const credit = (await ctx.db.query("dealAttributions").take(100)).find(c => c.role === "dm_closer")!;
        const { _id: cid, _creationTime: cc, ...c } = credit; void cid; void cc;
        await ctx.db.insert("dealAttributions", { ...c, meetingId, attributedAt: to + 100 });
        const dm = (await ctx.db.query("dmClosers").first())!;
        await ctx.db.insert("dmCloserSchedules", { tenantId: f.tenantId, dmCloserId: dm._id, weekday: "wednesday",
          scheduledHours: 7, updatedByUserId: f.admin, updatedAt: 0 });
      }
    });
    for (const memberId of [null, f.memberA, f.memberB]) for (const end of [to, to + DAY]) {
      const historyRange = { ...range, toMs: split, endDateInclusive: range.startDate };
      const history: PeopleRoleReport = await expectSameAnswer({ t: f.t, identity, tenantId: f.tenantId, range: historyRange,
        reportId: definition.id, live, liveArgs: { startDate: from, endDate: split, ...(memberId ? { memberId } : {}) }, filters: { memberId },
        rows: await roleAggregateRows(f.t, f.tenantId, role, memberId, historyRange, to + DAY) });
      const args = memberId ? { memberId } : {};
      const today = await f.t.withIdentity(identity).query(live, { ...args, startDate: split, endDate: end });
      const whole = await f.t.withIdentity(identity).query(live, { ...args, startDate: from, endDate: end });
      expect(mergePeopleRoles(history, today)).toEqual(whole);
    }
  });
  it("filters before the deterministic 300-item cut, keeping complete counts", async () => {
    const f = await createRoleFixture();
    await f.t.run(async ctx => {
      if (role === "lead_gen") {
        const c = (await ctx.db.query("leadGenSubmissions").first())!;
        const { _id, _creationTime, ...fields } = c; void _id; void _creationTime;
        for (let i = 0; i < 302; i++) await ctx.db.insert("leadGenSubmissions", { ...fields, workerId: i === 301 ? f.workerB : f.workerA, submittedAt: split + 5000 });
      } else if (role === "setter") {
        const q = (await ctx.db.query("slackQualificationEvents").first())!;
        const { _id, _creationTime, ...fields } = q; void _id; void _creationTime;
        for (let i = 0; i < 302; i++) await ctx.db.insert("slackQualificationEvents", { ...fields, slackUserId: i === 301 ? "UB" : "UA", submittedAt: split + 5000 });
      } else {
        const m = (await ctx.db.get("meetings", f.meetingA))!;
        const { _id, _creationTime, ...fields } = m; void _id; void _creationTime;
        const credit = (await ctx.db.query("dealAttributions").take(100)).find(c => c.role === "dm_closer")!;
        const { _id: cid, _creationTime: cc, ...c } = credit; void cid; void cc;
        const deal = (await ctx.db.get("opportunities", f.dealId))!;
        const { _id: did, _creationTime: dc, ...d } = deal; void did; void dc;
        const otherDeal = await ctx.db.insert("opportunities", d);
        for (let i = 0; i < 302; i++) {
          // Keep each deal below the live reader's 200-related-row cap.
          const opportunityId = i % 2 ? otherDeal : f.dealId;
          const meetingId = await ctx.db.insert("meetings", { ...fields, opportunityId, createdAt: split + 5000 });
          await ctx.db.insert("dealAttributions", { ...c, opportunityId, meetingId, teamMemberId: i === 301 ? f.memberB : f.memberA });
        }
      }
    });
    const rows = await roleAggregateRows(f.t, f.tenantId, role, f.memberA, range, to + DAY);
    const answer: PeopleRoleReport = await expectSameAnswer({ t: f.t, identity, tenantId: f.tenantId, range, reportId: definition.id,
      live, liveArgs: { startDate: from, endDate: to, memberId: f.memberA }, filters: { memberId: f.memberA }, rows });
    expect(answer.items).toHaveLength(300);
    expect(answer.isTruncated).toBe(false);
    expect(role === "lead_gen" ? answer.rows[0].captures : role === "setter" ? answer.rows[0].qualifications : answer.rows[0].bookings).toBe(303);
  });
});

it("setters resolve Slack user and team together and keep firstBookedAt after meetings are removed", async () => {
  const f = await createRoleFixture();
  await f.t.run(async ctx => {
    for (const m of await ctx.db.query("meetings").take(100)) await ctx.db.delete("meetings", m._id);
    const u = (await ctx.db.query("slackUsers").first())!;
    const { _id, _creationTime, ...fields } = u; void _id; void _creationTime;
    await ctx.db.insert("slackUsers", { ...fields, slackUserId: "UA", slackTeamId: "OTHER", teamMemberId: f.memberB });
    const q = (await ctx.db.query("slackQualificationEvents").first())!;
    const { _id: qid, _creationTime: qc, ...qualification } = q; void qid; void qc;
    await ctx.db.insert("slackQualificationEvents", { ...qualification, slackUserId: "UA", slackTeamId: "OTHER" });
    await ctx.db.insert("slackQualificationEvents", { ...qualification, slackUserId: "missing", slackTeamId: "OTHER" });
  });
  const rows = await roleAggregateRows(f.t, f.tenantId, "setter", null, range, to + DAY);
  const answer: PeopleRoleReport = await expectSameAnswer({ t: f.t, identity, tenantId: f.tenantId, range, reportId: peopleSettersNext.id,
    live: api.reports.peopleRoles.getSetters, liveArgs: { startDate: from, endDate: to }, filters: { memberId: null }, rows });
  expect(answer.rows.find(r => r.teamMemberId === f.memberB)).toMatchObject({ qualifications: 1, booked: 1, held: 0 });
  expect(answer.rows.find(r => r.key === "unlinked")?.qualifications).toBe(1);
});

it("DM payments suppress team fallback only for eligible named recipients, including unlinked ones", async () => {
  const f = await createRoleFixture();
  await f.t.run(async ctx => {
    const credits = await ctx.db.query("dealAttributions").take(100);
    for (const c of credits.filter(c => c.role === "dm_closer")) await ctx.db.delete("dealAttributions", c._id);
    const base = credits.find(c => c.role === "dm_closer")!;
    const { _id, _creationTime, ...fields } = base; void _id; void _creationTime;
    // Missing member still resolves to a named recipient, "unlinked".
    await ctx.db.insert("dealAttributions", { ...fields, teamMemberId: undefined, attributedAt: split + 1500 });
    // A second legitimate member gets full cash independently.
    await ctx.db.insert("dealAttributions", { ...fields, teamMemberId: f.memberB, attributedAt: split + 1500 });
  });
  const rows = await roleAggregateRows(f.t, f.tenantId, "dm_closer", null, range, to + DAY);
  const answer: PeopleRoleReport = await expectSameAnswer({ t: f.t, identity, tenantId: f.tenantId, range, reportId: peopleDmClosersNext.id,
    live: api.reports.peopleRoles.getDmClosers, liveArgs: { startDate: from, endDate: to }, filters: { memberId: null }, rows });
  expect(answer.rows.find(r => r.teamId === f.teamId)).toMatchObject({ byCurrency: [{ currency: "USD", amountMinor: 30000 }], dealsWon: 1, bookings: 1 });
  expect(answer.rows.find(r => r.key === "unlinked")).toMatchObject({ byCurrency: [{ currency: "EUR", amountMinor: 7000 }], bookings: 1 });
  expect(answer.rows.find(r => r.teamMemberId === f.memberB)?.byCurrency).toEqual([{ currency: "EUR", amountMinor: 7000 }]);
});

for (const { definition, role, live } of cases) it(`${definition.id} excludes payment-before-credit cash and private reconciliation ids`, async () => {
  const f = await createRoleFixture();
  await f.t.run(async ctx => {
    for (const c of await ctx.db.query("dealAttributions").take(100)) if (c.role === role || role === "dm_closer" && c.role === "dm_team")
      await ctx.db.patch("dealAttributions", c._id, { attributedAt: from + 200 });
    const p = (await ctx.db.query("paymentRecords").first())!;
    const { _id, _creationTime, ...fields } = p; void _id; void _creationTime;
    await ctx.db.insert("paymentRecords", { ...fields, recordedAt: from + 100, amountMinor: 999999 });
  });
  for (const memberId of [null, f.memberA, f.memberIdle]) {
    const rows = await roleAggregateRows(f.t, f.tenantId, role, memberId, range, to + DAY);
    const answer: PeopleRoleReport = await expectSameAnswer({ t: f.t, identity, tenantId: f.tenantId, range, reportId: definition.id,
      live, liveArgs: { startDate: from, endDate: to, ...(memberId ? { memberId } : {}) }, filters: { memberId }, rows });
    expect(answer.rows.every(r => r.byCurrency.every(c => c.amountMinor < 999999))).toBe(true);
    if (memberId === f.memberIdle && role !== "setter") expect(answer.firstPaymentDealIds).toEqual([]);
    if (memberId === f.memberA && role !== "setter") expect(answer.firstPaymentDealIds).toContain(f.dealId);
  }
});

for (const { definition, role } of cases.filter(c => c.role !== "setter")) it(`${definition.id} keeps the live two-stage first-payment tie rule`, async () => {
  const f = await createRoleFixture();
  const payments = await f.t.run(async ctx => {
    const payments = await ctx.db.query("paymentRecords").take(100);
    const { _id, _creationTime, ...fields } = payments[0]; void _id; void _creationTime;
    for (const p of payments) await ctx.db.delete("paymentRecords", p._id);
    const result: Doc<"paymentRecords">[] = [];
    for (const status of ["recorded", "recorded", "verified", "verified"] as const) {
      const id = await ctx.db.insert("paymentRecords", { ...fields, status });
      result.push((await ctx.db.get("paymentRecords", id))!);
    }
    return result;
  });
  const aliases = ["z-recorded-first", "a-recorded-later", "m-verified-first", "b-verified-later"];
  const ids = Object.fromEntries(payments.map((p, i) => [p._id, aliases[i] as Id<"paymentRecords">]));
  const input = { tenantId: f.tenantId, range, filters: { memberId: null } };
  const context = await f.t.run(ctx => definition.node!.context(ctx, input, []));
  const sql = definition.sql(input, context).wins.sql;
  const rows = payments.map(p => ({ ...rowFromDoc("paymentRecords", p), id: ids[p._id] }));
  expect(orderedLimitByRows(sql, rows.slice(0, 2)).map(r => r.id)).toEqual(["z-recorded-first"]);
  const winner = orderedLimitByRows(sql, rows).map(r => r.id);
  expect(winner).toEqual(["m-verified-first"]);
  const live = await f.t.run(ctx => loadCreditFacts(withOpaquePaymentIds(ctx, ids), f.tenantId, range, role));
  expect(winner).toEqual(live.firstPayments.map(p => p._id));
});

for (const { definition, role, live } of cases) it(`${definition.id} keeps dated schedules in the Convex context`, async () => {
  const f = await createRoleFixture();
  await f.t.run(async ctx => {
    if (role === "lead_gen") await ctx.db.insert("leadGenWorkerSchedules", { tenantId: f.tenantId, workerId: f.workerA,
      userId: f.closerA, weekday: "tuesday", effectiveFrom: range.endDateInclusive, scheduledHours: 6, updatedByUserId: f.admin, updatedAt: split });
    if (role === "dm_closer") {
      const dm = (await ctx.db.query("dmClosers").first())!;
      await ctx.db.insert("dmCloserSchedules", { tenantId: f.tenantId, dmCloserId: dm._id, weekday: "tuesday",
        effectiveFrom: range.endDateInclusive, scheduledHours: 6, updatedByUserId: f.admin, updatedAt: split });
    }
  });
  const rows = await roleAggregateRows(f.t, f.tenantId, role, f.memberA, range, to + DAY);
  const answer: PeopleRoleReport = await expectSameAnswer({ t: f.t, identity, tenantId: f.tenantId, range, reportId: definition.id,
    live, liveArgs: { startDate: from, endDate: to, memberId: f.memberA }, filters: { memberId: f.memberA }, rows });
  expect(answer.rows[0].scheduledHours).toBe(role === "setter" ? 14 : role === "lead_gen" ? 10 : 11);
});
