import { expect, it } from "vitest";
import { api } from "../../_generated/api";
import { createRoleFixture, from, split, to, identity } from "../../../tests/peopleRolesFixtures";
import { mergePeopleRoles } from "./peopleRoles";
import { shapePanel } from "../../../lib/reporting/pageFigures/panels";
import { mergeReportPanel } from "../../mcp/reports/merge";

for (const [role, multipleNamed] of [["dm_closer", false], ["lead_gen", false], ["dm_closer", true]] as const) {
  it(`${role}${multipleNamed ? " with multiple named recipients" : ""} reconciles changed first-payment recipients for roster and private member answers`, async () => {
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
          await ctx.db.patch("dealAttributions", c._id, { teamMemberId: f.memberB });
      }
      const base = credits.find(c => c.role === role)!;
      const { _id, _creationTime, ...fields } = base; void _id; void _creationTime;
      await ctx.db.insert("dealAttributions", { ...fields, teamMemberId: f.memberB, attributedAt: split });
      if (multipleNamed) await ctx.db.insert("dealAttributions", { ...fields, teamMemberId: f.memberA, attributedAt: split });
    });
    for (const [i, member] of members.entries()) {
      const today = await read(member, split, to);
      expect(today.firstPaymentDealIds).toContain(f.dealId);
      const whole = await read(member, from, to);
      for (const merged of [mergePeopleRoles(history[i], today), mergeReportPanel(`people.${role === "dm_closer" ? "dm_closers" : role}`, history[i], today) as typeof today]) {
        expect(merged.rows.map(r => [r.key, r.wonDealIds])).toEqual(whole.rows.map(r => [r.key, r.wonDealIds]));
        const id = `people.${role === "dm_closer" ? "dm_closers" : role}`;
        const figures = (answer: typeof today) => shapePanel(id, answer, new Map([[id, answer]]), { ...(member ? { memberId: member } : {}), currency: "USD" }).figures;
        if (member) expect(figures(merged)).toMatchObject({ won: { value: whole.rows[0]?.won ?? null } });
        else expect((figures(merged) as { rows: { key: string; won: number }[] }).rows.map(r => [r.key, r.won]))
          .toEqual((figures(whole) as { rows: { key: string; won: number }[] }).rows.map(r => [r.key, r.won]));
      }
    }
  });
}

it("keeps legacy cache merging and setter credit-based wins", async () => {
  const f = await createRoleFixture();
  for (const reader of [api.reports.peopleRoles.getSetters, api.reports.peopleRoles.getLeadGen]) {
    const history = await f.t.withIdentity(identity).query(reader, { startDate: from, endDate: split });
    const today = await f.t.withIdentity(identity).query(reader, { startDate: split, endDate: to });
    const { firstPaymentDealIds: _ids, ...legacy } = history; void _ids;
    const legacyMerged = mergePeopleRoles(legacy, today);
    expect(legacyMerged.firstPaymentDealIds).toBeUndefined();
    expect(legacyMerged.rows[0].wonDealIds).toEqual(history.rows[0].wonDealIds);
    if (history.role === "setter") {
      const merged = mergePeopleRoles({ ...history, firstPaymentDealIds: [] }, { ...today, firstPaymentDealIds: [f.dealId], rows: [] });
      expect(merged.rows[0].wonDealIds).toContain(f.dealId);
    }
  }
});
