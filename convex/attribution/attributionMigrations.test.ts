import { afterEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "../_generated/dataModel";
import {
  AT,
  attributionHarness,
  attributionRows,
  type AttributionHarness,
} from "../../tests/attributionFixtures";

// The Phase 3 health checks that stay after the narrow
// (docs/plans/phase-3-attribution.md §10): assertPersonTouches,
// assertBookingAttributions and assertDealAttributions, against touches and
// rows written the way the live write paths write them.

afterEach(() => vi.useRealTimers());

function rowsOf(rows: Doc<"dealAttributions">[], filter: Partial<Doc<"dealAttributions">>) {
  return rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => row[key as keyof typeof row] === value),
  );
}

async function insertCopyOf(harness: AttributionHarness, row: Doc<"dealAttributions">) {
  const { _id, _creationTime, ...fields } = row;
  void _id;
  void _creationTime;
  await harness.t.run((ctx) => ctx.db.insert("dealAttributions", fields));
}

describe("person touches", () => {
  it("holds each person's first and latest touch across the leads merged into them", async () => {
    const h = await attributionHarness();
    const { leads, events } = h.ids;
    const state = await h.t.run(async (ctx) => ({
      p1: await ctx.db.get("leads", leads.p1),
      p3: await ctx.db.get("leads", leads.p3),
      merged: await ctx.db.get("leads", leads.merged),
    }));
    expect(state.p1?.firstTouch).toEqual({
      eventId: events.captured, eventType: "lead.captured", channel: "lead_gen", occurredAt: AT.CAPTURED,
    });
    // The merged lead's portal note is P1's latest touch; the later status
    // change is not a touch.
    expect(state.p1?.latestTouch).toMatchObject({ eventId: events.portalNote, channel: "dm_portal" });
    expect(state.p3?.firstTouch).toMatchObject({ eventId: events.o3Created, channel: "slack" });
    expect(state.merged?.firstTouch).toBeUndefined();

    expect((await h.run("assertPersonTouches"))?.error).toBeUndefined();
  });

  it("names a person whose stored touch isn't the computed one, or who has none", async () => {
    const h = await attributionHarness();
    const { leads, events } = h.ids;
    await h.t.run((ctx) =>
      ctx.db.patch("leads", leads.p1, {
        firstTouch: { eventId: events.slackTouch, eventType: "lead.slack_qualified", channel: "slack", occurredAt: AT.SLACK_TOUCH },
      }),
    );
    let error = (await h.run("assertPersonTouches"))?.error;
    expect(error).toContain(leads.p1);
    expect(error).toContain(events.captured);

    // P1 repaired; P3 lost its latest touch.
    await h.t.run(async (ctx) => {
      await ctx.db.patch("leads", leads.p1, {
        firstTouch: { eventId: events.captured, eventType: "lead.captured", channel: "lead_gen", occurredAt: AT.CAPTURED },
      });
      await ctx.db.patch("leads", leads.p3, { latestTouch: undefined });
    });
    error = (await h.rerun("assertPersonTouches"))?.error;
    expect(error).toContain(leads.p3);
    expect(error).toContain("latestTouch none");
  });
});

describe("deal touch snapshots", () => {
  it("hold each deal's touches at its creation, plus its creating event", async () => {
    const h = await attributionHarness();
    const { opportunities, events } = h.ids;
    const deals = await h.t.run(async (ctx) => ({
      o1: await ctx.db.get("opportunities", opportunities.o1),
      o2: await ctx.db.get("opportunities", opportunities.o2),
      o3: await ctx.db.get("opportunities", opportunities.o3),
      o4: await ctx.db.get("opportunities", opportunities.o4),
    }));
    expect(deals.o1?.firstTouch?.eventId).toBe(events.captured);
    // Nothing after the deal's creation.
    expect(deals.o1?.latestTouch?.eventId).toBe(events.o1Created);
    expect(deals.o2?.firstTouch?.eventId).toBe(events.m3Created);
    expect(deals.o2?.latestTouch?.eventId).toBe(events.m3Created);
    expect(deals.o3?.firstTouch?.eventId).toBe(events.o3Created);
    expect(deals.o4?.firstTouch?.channel).toBe("side_deal");
  });
});

describe("booking attributions", () => {
  it("passes on each booking's rows", async () => {
    const h = await attributionHarness();
    const { meetings, teamA, teamB, dana, tm, closerId, adminId } = h.ids;

    const rows = await attributionRows(h);
    expect(rowsOf(rows, { role: "dm_team" })).toHaveLength(3);
    expect(rowsOf(rows, { role: "dm_closer" })).toHaveLength(1);

    const m1 = rowsOf(rows, { meetingId: meetings.m1 });
    expect(m1).toHaveLength(3);
    expect(rowsOf(m1, { role: "dm_team" })[0]).toMatchObject({
      teamId: teamA, source: { kind: "booking_utm" }, meetingScheduledAt: AT.CALL, attributedAt: AT.BOOKED,
    });
    expect(rowsOf(m1, { role: "dm_closer" })[0]).toMatchObject({
      teamMemberId: tm.dana, source: { kind: "booking_utm", dmCloserId: dana },
    });
    expect(rowsOf(m1, { role: "closer" })[0]).toMatchObject({
      teamMemberId: tm.closer, source: { kind: "booking_closer", userId: closerId },
    });

    // The rebook names team B only: its own team row, no DM closer row.
    const m2 = rowsOf(rows, { meetingId: meetings.m2 });
    expect(m2.map((row) => row.role).sort()).toEqual(["closer", "dm_team"]);
    expect(rowsOf(m2, { role: "dm_team" })[0].teamId).toBe(teamB);

    // Never resolved: only the closer, who is the closer it was reassigned
    // from, then a reassignment row to today's closer.
    const m3 = rowsOf(rows, { meetingId: meetings.m3 });
    expect(m3.map((row) => row.source)).toEqual([
      { kind: "booking_closer", userId: adminId },
      { kind: "reassignment", userId: closerId, fromUserId: adminId },
    ]);
    expect(m3[0].teamMemberId).toBe(tm.admin);
    expect(m3[1]).toMatchObject({ teamMemberId: tm.closer, attributedAt: AT.REASSIGNED });

    expect((await h.run("assertBookingAttributions"))?.error).toBeUndefined();
  });

  it("checks the dm_team row against the booking's resolution", async () => {
    const h = await attributionHarness();
    const { meetings } = h.ids;
    // A mapped booking without its team row fails.
    await h.t.run(async (ctx) => {
      const row = (await ctx.db.query("dealAttributions").take(500)).find(
        (candidate) => candidate.meetingId === meetings.m4 && candidate.role === "dm_team",
      );
      await ctx.db.delete("dealAttributions", row!._id);
    });
    let error = (await h.run("assertBookingAttributions"))?.error;
    expect(error).toContain(meetings.m4);
    expect(error).toContain("resolution mapped with no dm_team row");

    // So does a team row on a booking that matched no team.
    await h.t.run(async (ctx) => {
      await ctx.db.patch("meetings", meetings.m4, { attributionResolution: "none" });
      await ctx.db.patch("meetings", meetings.m2, { attributionResolution: "unmapped" });
    });
    error = (await h.rerun("assertBookingAttributions"))?.error;
    expect(error).toContain(meetings.m2);
    expect(error).toContain("resolution unmapped with a dm_team row");
  });

  it("fails on a dm_closer row with no dm_team row beside it", async () => {
    const h = await attributionHarness();
    const { meetings } = h.ids;
    await h.t.run(async (ctx) => {
      const row = (await ctx.db.query("dealAttributions").take(500)).find(
        (candidate) => candidate.meetingId === meetings.m1 && candidate.role === "dm_team",
      );
      await ctx.db.delete("dealAttributions", row!._id);
    });
    const error = (await h.run("assertBookingAttributions"))?.error;
    expect(error).toContain(meetings.m1);
    expect(error).toContain("no dm_team row beside it");
  });

  it("accepts a booking closer the pipeline moved to a later booking's host, and nothing else", async () => {
    const h = await attributionHarness();
    const { meetings, adminId, closerId, tm } = h.ids;
    const m2Closer = rowsOf(await attributionRows(h), { meetingId: meetings.m2, role: "closer" })[0];

    // The rebook went to the admin, and the pipeline moved the deal's
    // meetings to the new host.
    await h.t.run(async (ctx) => {
      await ctx.db.patch("dealAttributions", m2Closer._id, {
        teamMemberId: tm.admin, source: { kind: "booking_closer", userId: adminId },
      });
      await ctx.db.patch("meetings", meetings.m1, { assignedCloserId: adminId });
      await ctx.db.patch("meetings", meetings.m2, { assignedCloserId: adminId });
    });
    expect((await h.run("assertBookingAttributions"))?.error).toBeUndefined();

    // No later booking went to the admin: m1's row should name its closer.
    await h.t.run((ctx) =>
      ctx.db.patch("dealAttributions", m2Closer._id, {
        teamMemberId: tm.closer, source: { kind: "booking_closer", userId: closerId },
      }),
    );
    await h.t.run((ctx) => ctx.db.patch("meetings", meetings.m2, { assignedCloserId: closerId }));
    const error = (await h.rerun("assertBookingAttributions"))?.error;
    expect(error).toContain(meetings.m1);
    expect(error).toContain(closerId);
    expect(error).toContain(adminId);
  });

  it("expects a reassigned meeting's booking closer to be the closer it came from", async () => {
    const h = await attributionHarness();
    const { meetings, adminId, closerId } = h.ids;
    await h.t.run(async (ctx) => {
      const row = (await ctx.db.query("dealAttributions").take(500)).find(
        (candidate) => candidate.meetingId === meetings.m3 && candidate.source.kind === "booking_closer",
      );
      await ctx.db.patch("dealAttributions", row!._id, { source: { kind: "booking_closer", userId: closerId } });
    });
    const error = (await h.run("assertBookingAttributions"))?.error;
    expect(error).toContain(meetings.m3);
    expect(error).toContain(adminId);
  });

  for (const role of ["dm_team", "dm_closer", "closer"] as const) {
    it(`fails on a second ${role} row for one booking`, async () => {
      const h = await attributionHarness();
      const { meetings } = h.ids;
      const row = rowsOf(await attributionRows(h), { meetingId: meetings.m1, role })[0];
      await insertCopyOf(h, row);
      const error = (await h.run("assertBookingAttributions"))?.error;
      expect(error).toContain(meetings.m1);
      expect(error).toContain(row.source.kind === "booking_closer" ? "booking_closer" : role);
    });
  }
});

describe("deal attributions", () => {
  it("passes on each deal's lead gen, setter and side deal rows", async () => {
    const h = await attributionHarness();
    const { opportunities, tm, prospectId, workerId, events, qualifications, closerId } = h.ids;

    const rows = await attributionRows(h);
    expect(rowsOf(rows, { role: "lead_gen" })).toEqual([
      expect.objectContaining({
        opportunityId: opportunities.o1, teamMemberId: tm.admin, attributedAt: AT.CAPTURED,
        source: { kind: "capture", prospectId, workerId, eventId: events.captured },
      }),
    ]);

    // The deal's creator and the setter who joined it; not the same setter
    // twice, and not the already_booked qualification.
    const o1Setters = rowsOf(rows, { opportunityId: opportunities.o1, role: "setter" });
    expect(o1Setters.map((row) => [row.teamMemberId, row.source])).toEqual([
      [tm.u1, { kind: "slack_qualification", slackUserId: "U1", qualificationEventId: qualifications.created }],
      [tm.u2, { kind: "slack_qualification", slackUserId: "U2", qualificationEventId: qualifications.joined }],
    ]);
    // The early Slack deal's setter comes from qualifiedBy.
    expect(rowsOf(rows, { opportunityId: opportunities.o3, role: "setter" })).toEqual([
      expect.objectContaining({
        teamMemberId: tm.u2, attributedAt: AT.EARLY_SLACK, source: { kind: "slack_qualification", slackUserId: "U2" },
      }),
    ]);
    expect(rowsOf(rows, { role: "setter" })).toHaveLength(3);
    expect(rowsOf(rows, { opportunityId: opportunities.o4 })).toEqual([
      expect.objectContaining({ role: "closer", teamMemberId: tm.closer, source: { kind: "side_deal", userId: closerId } }),
    ]);

    expect((await h.run("assertDealAttributions"))?.error).toBeUndefined();
  });

  it("fails on a second lead gen row", async () => {
    const h = await attributionHarness();
    await insertCopyOf(h, rowsOf(await attributionRows(h), { role: "lead_gen" })[0]);
    const error = (await h.run("assertDealAttributions"))?.error;
    expect(error).toContain(h.ids.opportunities.o1);
    expect(error).toContain("lead_gen");
  });

  it("fails on a second setter row for one team member, but allows two setters", async () => {
    const h = await attributionHarness();
    const { opportunities, tm } = h.ids;
    const rows = rowsOf(await attributionRows(h), { opportunityId: opportunities.o1, role: "setter" });
    expect(rows).toHaveLength(2);
    expect((await h.run("assertDealAttributions"))?.error).toBeUndefined();

    await insertCopyOf(h, rows.find((row) => row.teamMemberId === tm.u1)!);
    const error = (await h.rerun("assertDealAttributions"))?.error;
    expect(error).toContain(opportunities.o1);
    expect(error).toContain(tm.u1);
  });

  it("fails on a second side deal closer row, and allows a reassignment row", async () => {
    const h = await attributionHarness();
    const { opportunities, adminId, closerId, tm } = h.ids;
    const sideDeal = rowsOf(await attributionRows(h), { opportunityId: opportunities.o4 })[0];
    await h.t.run((ctx) =>
      ctx.db.insert("dealAttributions", {
        tenantId: sideDeal.tenantId, opportunityId: opportunities.o4, role: "closer", teamMemberId: tm.admin,
        source: { kind: "reassignment", userId: adminId, fromUserId: closerId }, attributedAt: AT.LATER, createdAt: 0,
      }),
    );
    expect((await h.run("assertDealAttributions"))?.error).toBeUndefined();

    await insertCopyOf(h, sideDeal);
    const error = (await h.rerun("assertDealAttributions"))?.error;
    expect(error).toContain(opportunities.o4);
    expect(error).toContain("side_deal");
  });

  it("fails on a missing setter, a row without a team member, and a team from another tenant", async () => {
    const h = await attributionHarness();
    const { opportunities, tm } = h.ids;
    const o3Setter = rowsOf(await attributionRows(h), { opportunityId: opportunities.o3, role: "setter" })[0];
    await h.t.run((ctx) => ctx.db.delete("dealAttributions", o3Setter._id));
    expect((await h.run("assertDealAttributions"))?.error).toContain(opportunities.o3);

    await insertCopyOf(h, o3Setter);
    await h.t.run(async (ctx) => {
      const row = (await ctx.db.query("dealAttributions").take(500)).find(
        (candidate) => candidate.opportunityId === opportunities.o1 && candidate.role === "lead_gen",
      );
      await ctx.db.patch("dealAttributions", row!._id, { teamMemberId: undefined });
    });
    expect((await h.rerun("assertDealAttributions"))?.error).toContain("lead_gen");

    await h.t.run(async (ctx) => {
      const row = (await ctx.db.query("dealAttributions").take(500)).find(
        (candidate) => candidate.opportunityId === opportunities.o1 && candidate.role === "lead_gen",
      );
      await ctx.db.patch("dealAttributions", row!._id, { teamMemberId: tm.admin });
      const otherTenant = await ctx.db.insert("tenants", {
        companyName: "Other", contactEmail: "o@example.com", workosOrgId: "org_other", status: "active",
        inviteExpiresAt: 0, createdBy: "test",
      });
      const foreignTeam = await ctx.db.insert("attributionTeams", {
        tenantId: otherTenant, slug: "x", displayName: "X", utmSource: "x", normalizedUtmSource: "x",
        isActive: true, createdAt: 0, updatedAt: 0,
      });
      const teamRow = (await ctx.db.query("dealAttributions").take(500)).find(
        (candidate) => candidate.opportunityId === opportunities.o5 && candidate.role === "dm_team",
      );
      await ctx.db.patch("dealAttributions", teamRow!._id, { teamId: foreignTeam });
    });
    const error = (await h.rerun("assertDealAttributions"))?.error;
    expect(error).toContain(opportunities.o5);
    expect(error).toContain("tenant");
  });
});

describe("a closer whose user was deleted", () => {
  it("keeps its row without a team member, and only then", async () => {
    const h = await attributionHarness();
    const closerRow = rowsOf(await attributionRows(h), { meetingId: h.ids.meetings.m1, role: "closer" })[0];
    await h.t.run((ctx) => ctx.db.patch("dealAttributions", closerRow._id, { teamMemberId: undefined }));

    // Its user still exists: the row should name the user's team member.
    expect((await h.rerun("assertBookingAttributions"))?.error).toContain(closerRow._id);
    expect((await h.rerun("assertDealAttributions"))?.error).toContain(closerRow._id);

    // Once the user is gone there is no team member to name; the user ID stays.
    const userId = closerRow.source.kind === "booking_closer" ? closerRow.source.userId : undefined;
    if (!userId) throw new Error("expected a booking closer row");
    await h.t.run(async (ctx) => {
      for (const row of await ctx.db.query("dealAttributions").take(500)) {
        if (row._id !== closerRow._id && "userId" in row.source && row.source.userId === userId) {
          await ctx.db.patch("dealAttributions", row._id, { teamMemberId: undefined });
        }
      }
      await ctx.db.delete("users", userId);
    });
    expect((await h.rerun("assertBookingAttributions"))?.error).toBeUndefined();
    expect((await h.rerun("assertDealAttributions"))?.error).toBeUndefined();
  });
});
