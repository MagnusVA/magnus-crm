import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import {
  callsReportFixture,
  from,
  identity,
  to,
} from "../../tests/callsReportFixtures";

describe("Report Log", () => {
  it("paginates newest first, filters actors and members, and labels events", async () => {
    const f = await callsReportFixture();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 6; i++)
        await ctx.db.insert("domainEvents", {
          tenantId: f.tenantId,
          entityType: i % 2 ? "meeting" : "payment",
          entityId: String(i),
          eventType: i % 2 ? "meeting.no_show" : "payment.recorded",
          occurredAt: from + i,
          actorUserId: i % 2 ? f.beto : f.ana,
          teamMemberId: i % 2 ? f.memberB : f.memberA,
          source: "closer",
          metadata: i === 2 ? "invalid" : '{"amount":10}',
        });
      await ctx.db.insert("domainEvents", {
        tenantId: f.tenantId,
        entityType: "lead",
        entityId: "excluded",
        eventType: "lead.created",
        occurredAt: to,
        source: "system",
      });
    });
    const admin = f.t.withIdentity(identity);
    const args = {
      startDate: from,
      endDate: to,
      paginationOpts: { numItems: 2, cursor: null },
    };
    const first = await admin.query(api.reports.log.listLog, args);
    expect(first.page.map((e) => e.entityId)).toEqual(["5", "4"]);
    expect(first.page[0]).toMatchObject({
      label: "marked a meeting as no-show",
      actorName: "Beto",
      metadata: { amount: 10 },
    });
    const second = await admin.query(api.reports.log.listLog, {
      ...args,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((e) => e.entityId)).toEqual(["3", "2"]);
    expect(second.page[1].metadata).toBeNull();
    const filtered = await admin.query(api.reports.log.listLog, {
      ...args,
      actorUserId: f.ana,
      entityType: "payment",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(filtered.page.map((e) => e.entityId)).toEqual(["4", "2", "0"]);
    await f.t.run(async (ctx) => {
      await ctx.db.insert("domainEvents", {
        tenantId: f.tenantId,
        entityType: "meeting",
        entityId: "legacy",
        eventType: "meeting.created",
        occurredAt: from + 10,
        actorUserId: f.ana,
        source: "closer",
      });
    });
    const own = f.t.withIdentity({
      subject: "reports_ana",
      org_id: identity.org_id,
    });
    expect(
      (
        await own.query(api.reports.log.listMemberLog, {
          ...args,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((e) => e.entityId),
    ).toEqual(["4", "2", "0"]);
    // Events tagged with the member that her login didn't record: a Slack
    // qualification the system logged, and another person's action.
    await f.t.run(async (ctx) => {
      await ctx.db.insert("domainEvents", {
        tenantId: f.tenantId, entityType: "lead", entityId: "slack", eventType: "lead.qualified",
        occurredAt: from + 7, teamMemberId: f.memberA, source: "system",
      });
      await ctx.db.insert("domainEvents", {
        tenantId: f.tenantId, entityType: "meeting", entityId: "byBeto", eventType: "meeting.held",
        occurredAt: from + 8, actorUserId: f.beto, teamMemberId: f.memberA, source: "closer",
      });
    });
    expect(
      (
        await own.query(api.reports.log.listMemberLog, {
          ...args,
          actorUserId: f.ana,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((e) => e.entityId),
    ).toEqual(["legacy", "byBeto", "slack", "4", "2", "0"]);
    await expect(
      own.query(api.reports.log.listMemberLog, {
        ...args,
        teamMemberId: f.memberB,
      }),
    ).rejects.toThrow("only open your own");
    await expect(
      own.query(api.reports.log.listMemberLog, {
        ...args,
        actorUserId: f.beto,
      }),
    ).rejects.toThrow("only open this member");
    await expect(own.query(api.reports.log.listLog, args)).rejects.toThrow(
      "Insufficient permissions",
    );
  });
});
