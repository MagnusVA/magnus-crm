import { expect, it } from "vitest";
import { api } from "../../_generated/api";
import { createRoleFixture, from, split, to, identity } from "../../../tests/peopleRolesFixtures";
import { mergePeopleRoles } from "./peopleRoles";
import { mergeReportPanel } from "../../mcp/reports/merge";

for (const role of ["dm_closer", "lead_gen"] as const) {
  it(`${role} reconciles changed first-payment recipients for roster and private member answers`, async () => {
    const f = await createRoleFixture();
    const reader = role === "dm_closer" ? api.reports.peopleRoles.getDmClosers : api.reports.peopleRoles.getLeadGen;
    await f.t.run(async ctx => {
      const credits = await ctx.db.query("dealAttributions").take(100);
      for (const credit of credits.filter(c => c.role === role)) {
        // Old credits remain in the chain, but happen after the new first
        // payment. Thus the old member may see this deal's reconciliation id.
        await ctx.db.patch("dealAttributions", credit._id, { attributedAt: to - 1 });
      }
      if (role === "lead_gen") {
        const credit = credits.find(c => c.role === role)!;
        await ctx.db.patch("dealAttributions", credit._id, { attributedAt: from });
      }
    });
    const read = (memberId: typeof f.memberA | null, startDate: number, endDate: number) =>
      f.t.withIdentity(identity).query(reader, { startDate, endDate, ...(memberId ? { memberId } : {}) });
    const members = [null, f.memberA, f.memberB];
    const history = await Promise.all(members.map(member => read(member, from, split)));
    await f.t.run(async ctx => {
      for (const p of await ctx.db.query("paymentRecords").take(100)) {
        if (p.recordedAt < split) await ctx.db.patch("paymentRecords", p._id, { status: "disputed" });
      }
      const credits = await ctx.db.query("dealAttributions").take(100);
      if (role === "lead_gen") {
        for (const c of credits.filter(c => c.role === role && c.attributedAt === from))
          await ctx.db.patch("dealAttributions", c._id, { attributedAt: to - 1 });
      }
      const base = credits.find(c => c.role === role)!;
      const { _id, _creationTime, ...fields } = base; void _id; void _creationTime;
      await ctx.db.insert("dealAttributions", { ...fields, teamMemberId: f.memberB, attributedAt: split });
    });
    for (const [i, member] of members.entries()) {
      const today = await read(member, split, to);
      expect(today.firstPaymentDealIds).toContain(f.dealId);
      const whole = await read(member, from, to);
      for (const merged of [mergePeopleRoles(history[i], today), mergeReportPanel(`people.${role === "dm_closer" ? "dm_closers" : role}`, history[i], today) as typeof today]) {
        expect(merged.rows.map(r => [r.key, r.wonDealIds])).toEqual(whole.rows.map(r => [r.key, r.wonDealIds]));
      }
    }
  });
}
