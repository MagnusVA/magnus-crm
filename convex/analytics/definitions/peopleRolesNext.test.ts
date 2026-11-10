import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { PeopleRoleReport } from "../../reports/peopleRoles";
import { expectSameAnswer } from "../../../tests/analyticsParity";
import { roleAggregateRows } from "../../../tests/peopleRolesAggregateFixtures";
import { createRoleFixture, DAY, from, split, to, range, identity } from "../../../tests/peopleRolesFixtures";
import { peopleLeadGenNext } from "./peopleRolesNext";
import { getReportDefinition, listReportDefinitions } from "../registry";
import { REPORT_PANELS } from "../../mcp/reports/catalog";
import { mergePeopleRoles } from "../merge/peopleRoles";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(to + DAY); });
afterEach(() => vi.useRealTimers());
const cases = [{ definition: peopleLeadGenNext, role: "lead_gen", live: api.reports.peopleRoles.getLeadGen }] as const;
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
      const c = (await ctx.db.query("leadGenSubmissions").first())!;
      const { _id, _creationTime, ...fields } = c; void _id; void _creationTime;
      for (let i = 0; i < 302; i++) await ctx.db.insert("leadGenSubmissions", { ...fields, workerId: i === 301 ? f.workerB : f.workerA, submittedAt: split + 5000 });
    });
    const rows = await roleAggregateRows(f.t, f.tenantId, role, f.memberA, range, to + DAY);
    const answer: PeopleRoleReport = await expectSameAnswer({ t: f.t, identity, tenantId: f.tenantId, range, reportId: definition.id,
      live, liveArgs: { startDate: from, endDate: to, memberId: f.memberA }, filters: { memberId: f.memberA }, rows });
    expect(answer.items).toHaveLength(300);
    expect(answer.isTruncated).toBe(false);
    expect(answer.rows[0].captures).toBe(303);
  });
});
