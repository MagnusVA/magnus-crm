import { afterEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import {
  AT,
  attributionHarness,
  attributionRows,
  backfillAll,
  type AttributionHarness,
} from "../../tests/attributionFixtures";

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
  it("backfills first and latest touch across merged leads, skips merged leads, and leaves updatedAt", async () => {
    const h = await attributionHarness();
    const { leads, events } = h.ids;
    expect((await h.run("assertPersonTouches"))?.error).toContain(leads.p1);
    expect((await h.run("backfillPersonTouches"))?.isDone).toBe(true);

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
    expect(state.p1?.updatedAt).toBe(123);
    expect(state.p3?.firstTouch).toMatchObject({ eventId: events.o3Created, channel: "slack" });
    expect(state.merged?.firstTouch).toBeUndefined();

    expect((await h.rerun("assertPersonTouches"))?.error).toBeUndefined();
  });

  it("names a person whose stored touch isn't the computed one", async () => {
    const h = await attributionHarness();
    await h.run("backfillPersonTouches");
    const { leads, events } = h.ids;
    await h.t.run((ctx) =>
      ctx.db.patch("leads", leads.p1, {
        firstTouch: { eventId: events.slackTouch, eventType: "lead.slack_qualified", channel: "slack", occurredAt: AT.SLACK_TOUCH },
      }),
    );
    const error = (await h.run("assertPersonTouches"))?.error;
    expect(error).toContain(leads.p1);
    expect(error).toContain(events.captured);

    // The backfill repairs it and only that field.
    await h.rerun("backfillPersonTouches");
    expect((await h.rerun("assertPersonTouches"))?.error).toBeUndefined();
  });
});

describe("deal touches", () => {
  it("snapshots each deal's touches at its creation, plus its creating event", async () => {
    const h = await attributionHarness();
    const { opportunities, events } = h.ids;
    expect((await h.run("assertDealTouches"))?.error).toContain("no touch snapshot");
    expect((await h.run("backfillDealTouches"))?.isDone).toBe(true);

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

    expect((await h.rerun("assertDealTouches"))?.error).toBeUndefined();
  });

  it("names a deal missing half its snapshot or holding the wrong one", async () => {
    const h = await attributionHarness();
    await h.run("backfillDealTouches");
    const { opportunities, events } = h.ids;
    await h.t.run((ctx) => ctx.db.patch("opportunities", opportunities.o3, { latestTouch: undefined }));
    expect((await h.run("assertDealTouches"))?.error).toContain(opportunities.o3);

    await h.t.run(async (ctx) => {
      const o3 = await ctx.db.get("opportunities", opportunities.o3);
      await ctx.db.patch("opportunities", opportunities.o3, { latestTouch: o3!.firstTouch });
      await ctx.db.patch("opportunities", opportunities.o1, {
        latestTouch: { eventId: events.portalNote, eventType: "lead.portal_note_added", channel: "dm_portal", occurredAt: AT.LATER },
      });
    });
    expect((await h.rerun("assertDealTouches"))?.error).toContain(opportunities.o1);
  });
});

describe("booking attributions", () => {
  it("writes each booking's rows from its copies and its closer, once", async () => {
    const h = await attributionHarness();
    const { meetings, teamA, teamB, dana, tm, closerId, adminId } = h.ids;
    expect((await h.run("backfillBookingAttributions"))?.isDone).toBe(true);

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

    // A rerun adds nothing.
    await h.rerun("backfillBookingAttributions");
    expect(await attributionRows(h)).toHaveLength(rows.length);
  });

  it("still passes once the copies are cleared, against the resolution", async () => {
    const h = await attributionHarness();
    const { meetings } = h.ids;
    await h.run("backfillBookingAttributions");
    await h.t.run(async (ctx) => {
      for (const meetingId of Object.values(meetings)) {
        await ctx.db.patch("meetings", meetingId, { attributionTeamId: undefined, dmCloserId: undefined });
      }
    });
    expect((await h.run("assertBookingAttributions"))?.error).toBeUndefined();

    // A mapped booking without its team row fails, copies or not.
    await h.t.run(async (ctx) => {
      const row = (await ctx.db.query("dealAttributions").take(500)).find(
        (candidate) => candidate.meetingId === meetings.m4 && candidate.role === "dm_team",
      );
      await ctx.db.delete("dealAttributions", row!._id);
    });
    const error = (await h.rerun("assertBookingAttributions"))?.error;
    expect(error).toContain(meetings.m4);
    expect(error).toContain("mapped");
  });

  it("fails on a meeting whose rows don't match its copies", async () => {
    const h = await attributionHarness();
    const { meetings, teamB } = h.ids;
    await h.run("backfillBookingAttributions");
    await h.t.run(async (ctx) => {
      const row = (await ctx.db.query("dealAttributions").take(500)).find(
        (candidate) => candidate.meetingId === meetings.m1 && candidate.role === "dm_team",
      );
      await ctx.db.patch("dealAttributions", row!._id, { teamId: teamB });
    });
    const error = (await h.run("assertBookingAttributions"))?.error;
    expect(error).toContain(meetings.m1);
    expect(error).toContain(teamB);
  });

  it("accepts a booking closer the pipeline moved to a later booking's host, and nothing else", async () => {
    const h = await attributionHarness();
    const { meetings, adminId, closerId, tm } = h.ids;
    await h.run("backfillBookingAttributions");
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
    await h.run("backfillBookingAttributions");
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
      await h.run("backfillBookingAttributions");
      const row = rowsOf(await attributionRows(h), { meetingId: meetings.m1, role })[0];
      await insertCopyOf(h, row);
      const error = (await h.run("assertBookingAttributions"))?.error;
      expect(error).toContain(meetings.m1);
      expect(error).toContain(row.source.kind === "booking_closer" ? "booking_closer" : role);
    });
  }
});

describe("deal attributions", () => {
  it("writes lead gen, setter and side deal rows, and a rerun adds nothing", async () => {
    const h = await attributionHarness();
    const { opportunities, tm, prospectId, workerId, events, qualifications, closerId } = h.ids;
    await backfillAll(h);

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
    await h.rerun("backfillDealAttributions");
    expect(await attributionRows(h)).toHaveLength(rows.length);
  });

  it("checks a deal's copy against its first booking's rows while the copy exists", async () => {
    const h = await attributionHarness();
    await backfillAll(h);
    const { opportunities, dana, teamA } = h.ids;
    // o1 and o5 carry copies that match; o2, o3 and o4 have none.
    expect((await h.run("assertDealAttributions"))?.error).toBeUndefined();

    await h.t.run((ctx) => ctx.db.patch("opportunities", opportunities.o5, { dmCloserId: dana }));
    let error = (await h.rerun("assertDealAttributions"))?.error;
    expect(error).toContain(opportunities.o5);
    expect(error).toContain(`DM closer ${dana}`);
    expect(error).toContain("DM closer none");

    // A copy with no first booking has no rows to match.
    await h.t.run(async (ctx) => {
      await ctx.db.patch("opportunities", opportunities.o5, { dmCloserId: undefined });
      await ctx.db.patch("opportunities", opportunities.o3, { attributionTeamId: teamA });
    });
    error = (await h.rerun("assertDealAttributions"))?.error;
    expect(error).toContain(opportunities.o3);
    expect(error).toContain(`team ${teamA}`);

    // Once the copies are cleared there is nothing to compare.
    await h.t.run(async (ctx) => {
      for (const id of Object.values(opportunities)) {
        await ctx.db.patch("opportunities", id, { attributionTeamId: undefined, dmCloserId: undefined });
      }
    });
    expect((await h.rerun("assertDealAttributions"))?.error).toBeUndefined();
  });

  it("fails on a second lead gen row", async () => {
    const h = await attributionHarness();
    await backfillAll(h);
    await insertCopyOf(h, rowsOf(await attributionRows(h), { role: "lead_gen" })[0]);
    const error = (await h.run("assertDealAttributions"))?.error;
    expect(error).toContain(h.ids.opportunities.o1);
    expect(error).toContain("lead_gen");
  });

  it("fails on a second setter row for one team member, but allows two setters", async () => {
    const h = await attributionHarness();
    await backfillAll(h);
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
    await backfillAll(h);
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
    await backfillAll(h);
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

describe("qualification attribution parity", () => {
  it("matches each qualification row's copy with its deal's first booking rows", async () => {
    const h = await attributionHarness();
    await backfillAll(h);
    expect((await h.run("assertQualificationAttributionParity"))?.error).toBeUndefined();

    const { qualifications, dana } = h.ids;
    await h.t.run(async (ctx) => {
      const row = await ctx.db
        .query("operationsQualificationRows")
        .withIndex("by_qualificationEventId", (q) => q.eq("qualificationEventId", qualifications.joined))
        .unique();
      await ctx.db.patch("operationsQualificationRows", row!._id, { dmCloserId: undefined });
    });
    const error = (await h.rerun("assertQualificationAttributionParity"))?.error;
    expect(error).toContain("Qualification row");
    expect(error).toContain(dana);
  });

  it("checks the badge against the first booking's resolution", async () => {
    const h = await attributionHarness();
    await backfillAll(h);
    const { meetings } = h.ids;
    await h.t.run((ctx) => ctx.db.patch("meetings", meetings.m1, { attributionResolution: "unmapped" }));
    expect((await h.run("assertQualificationAttributionParity"))?.error).toContain("unmapped");
  });
});

describe("a closer whose user was deleted", () => {
  it("keeps its row without a team member, and only then", async () => {
    const h = await attributionHarness();
    await backfillAll(h);
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

describe("clearing the attribution copies", () => {
  // The fields each clear unsets (docs/plans/phase-3-attribution.md §3.3).
  // Meetings keep their resolution, UTMs and utmTruncated.
  const COPIES = {
    opportunities: [
      "attributionTeamId",
      "dmCloserId",
      "attributionResolution",
      "attributionResolvedAt",
      "attributionResolutionVersion",
    ],
    meetings: ["attributionTeamId", "dmCloserId"],
    operationsQualificationRows: ["attributionTeamId", "dmCloserId", "attributionResolution"],
    operationsMeetingDailyStats: ["attributionTeamId", "dmCloserId"],
  } as const;
  type CopyTable = keyof typeof COPIES;
  const MIGRATIONS: Record<CopyTable, { clear: string; assert: string }> = {
    opportunities: {
      clear: "clearOpportunityAttributionCopies",
      assert: "assertOpportunityAttributionCopiesCleared",
    },
    meetings: {
      clear: "clearMeetingAttributionCopies",
      assert: "assertMeetingAttributionCopiesCleared",
    },
    operationsQualificationRows: {
      clear: "clearQualificationRowAttributionCopies",
      assert: "assertQualificationRowAttributionCopiesCleared",
    },
    operationsMeetingDailyStats: {
      clear: "clearMeetingDailyStatAttributionCopies",
      assert: "assertMeetingDailyStatAttributionCopiesCleared",
    },
  };
  const TABLES = Object.keys(COPIES) as CopyTable[];

  function held(row: object, table: CopyTable) {
    const copies: readonly string[] = COPIES[table];
    return Object.entries(row).filter(([field, value]) => copies.includes(field) && value !== undefined);
  }

  function withoutCopies(row: object, table: CopyTable) {
    const copies: readonly string[] = COPIES[table];
    return Object.fromEntries(Object.entries(row).filter(([field]) => !copies.includes(field)));
  }

  async function readAll(h: AttributionHarness) {
    return await h.t.run(async (ctx) => ({
      opportunities: await ctx.db.query("opportunities").take(100),
      meetings: await ctx.db.query("meetings").take(100),
      operationsQualificationRows: await ctx.db.query("operationsQualificationRows").take(100),
      operationsMeetingDailyStats: await ctx.db.query("operationsMeetingDailyStats").take(100),
      dealAttributions: await ctx.db.query("dealAttributions").take(500),
      domainEvents: await ctx.db.query("domainEvents").take(500),
    }));
  }

  /** The legacy daily stats, which kept a copy in their key; one has none. */
  async function seedDailyStats(h: AttributionHarness) {
    const { closerId, teamA, dana } = h.ids;
    return await h.t.run(async (ctx) => {
      const base = {
        tenantId: h.tenantId, assignedCloserId: closerId, meetingStatus: "completed" as const, updatedAt: 0,
      };
      return {
        withCopies: await ctx.db.insert("operationsMeetingDailyStats", {
          ...base, dayKey: "2026-08-06", attributionTeamId: teamA, dmCloserId: dana, count: 2,
        }),
        without: await ctx.db.insert("operationsMeetingDailyStats", { ...base, dayKey: "2026-08-12", count: 1 }),
      };
    });
  }

  async function qualificationRowId(h: AttributionHarness, qualificationEventId: Id<"slackQualificationEvents">) {
    const row = await h.t.run((ctx) =>
      ctx.db
        .query("operationsQualificationRows")
        .withIndex("by_qualificationEventId", (q) => q.eq("qualificationEventId", qualificationEventId))
        .unique(),
    );
    return row!._id;
  }

  /** Production after PR 1's backfills: rows beside the copies. */
  async function clearHarness() {
    const h = await attributionHarness();
    await backfillAll(h);
    const { opportunities, meetings } = h.ids;
    const utmParams = { utm_source: "alpha", utm_medium: "dana" };
    await h.t.run(async (ctx) => {
      const resolved = { attributionResolvedAt: AT.BOOKED, attributionResolutionVersion: 2 };
      await ctx.db.patch("opportunities", opportunities.o1, { ...resolved, utmParams });
      await ctx.db.patch("meetings", meetings.m1, { ...resolved, utmParams, utmTruncated: false });
    });
    const daily = await seedDailyStats(h);
    return { h, daily, utmParams };
  }

  it("unsets every copy on the four tables and changes nothing else", async () => {
    const { h, daily, utmParams } = await clearHarness();
    const { opportunities, meetings, qualifications } = h.ids;
    const before = await readAll(h);
    // Copies to clear on every table: o1 and o5; m1, m2 and m4; every
    // qualification row (the unlinked one holds its "none" badge); one daily
    // stats row.
    const holding = (table: CopyTable) =>
      before[table].filter((row) => held(row, table).length > 0).map((row) => row._id).sort();
    expect(holding("opportunities")).toEqual([opportunities.o1, opportunities.o5].sort());
    expect(holding("meetings")).toEqual([meetings.m1, meetings.m2, meetings.m4].sort());
    expect(holding("operationsQualificationRows")).toHaveLength(Object.keys(qualifications).length);
    expect(holding("operationsMeetingDailyStats")).toEqual([daily.withCopies]);

    // Each assert fails first, on the first row with a copy.
    expect((await h.run(MIGRATIONS.opportunities.assert))?.error).toContain(
      `Opportunity ${opportunities.o1} still has attributionTeamId, dmCloserId, attributionResolution, attributionResolvedAt, attributionResolutionVersion`,
    );
    expect((await h.run(MIGRATIONS.meetings.assert))?.error).toContain(
      `Meeting ${meetings.m1} still has attributionTeamId, dmCloserId`,
    );
    expect((await h.run(MIGRATIONS.operationsQualificationRows.assert))?.error).toContain(
      `Qualification row ${await qualificationRowId(h, qualifications.created)} still has`,
    );
    expect((await h.run(MIGRATIONS.operationsMeetingDailyStats.assert))?.error).toContain(
      `Meeting daily stats row ${daily.withCopies} still has attributionTeamId, dmCloserId`,
    );

    for (const table of TABLES) {
      const result = await h.run(MIGRATIONS[table].clear);
      expect(result?.error).toBeUndefined();
      expect(result?.isDone).toBe(true);
    }

    const after = await readAll(h);
    for (const table of TABLES) {
      expect(after[table].flatMap((row) => held(row, table))).toEqual([]);
      expect(after[table].map((row) => withoutCopies(row, table))).toEqual(
        before[table].map((row) => withoutCopies(row, table)),
      );
      expect((await h.rerun(MIGRATIONS[table].assert))?.error).toBeUndefined();
    }
    // The booking keeps its own record; the deal its first booking caches.
    expect(after.meetings.find((row) => row._id === meetings.m1)).toMatchObject({
      attributionResolution: "mapped", attributionResolvedAt: AT.BOOKED, attributionResolutionVersion: 2,
      utmParams, utmTruncated: false,
    });
    expect(after.meetings.find((row) => row._id === meetings.m2)?.attributionResolution).toBe("mapped");
    expect(after.opportunities.find((row) => row._id === opportunities.o1)).toMatchObject({
      firstMeetingId: meetings.m1, utmParams,
    });
    // No row, event or daily stats count moves.
    expect(after.dealAttributions).toEqual(before.dealAttributions);
    expect(after.domainEvents).toEqual(before.domainEvents);
    expect(after.operationsMeetingDailyStats.map((row) => row.count)).toEqual([2, 1]);

    // The rows still pass, now against each meeting's resolution.
    expect((await h.rerun("assertBookingAttributions"))?.error).toBeUndefined();
    expect((await h.rerun("assertDealAttributions"))?.error).toBeUndefined();

    // A rerun finds nothing to clear.
    for (const table of TABLES) {
      expect((await h.rerun(MIGRATIONS[table].clear))?.error).toBeUndefined();
    }
    expect(await readAll(h)).toEqual(after);
  });

  it("each assert names a row that holds a copy again, and its field", async () => {
    const { h, daily } = await clearHarness();
    const { opportunities, meetings, qualifications, teamA, dana } = h.ids;
    for (const table of TABLES) await h.run(MIGRATIONS[table].clear);

    const joinedRow = await qualificationRowId(h, qualifications.joined);
    await h.t.run(async (ctx) => {
      await ctx.db.patch("opportunities", opportunities.o3, { attributionResolvedAt: AT.LATER });
      await ctx.db.patch("meetings", meetings.m2, { dmCloserId: dana });
      await ctx.db.patch("operationsQualificationRows", joinedRow, { attributionResolution: "none" });
      await ctx.db.patch("operationsMeetingDailyStats", daily.without, { attributionTeamId: teamA });
    });

    expect((await h.run(MIGRATIONS.opportunities.assert))?.error).toContain(
      `Opportunity ${opportunities.o3} still has attributionResolvedAt`,
    );
    expect((await h.run(MIGRATIONS.meetings.assert))?.error).toContain(`Meeting ${meetings.m2} still has dmCloserId`);
    expect((await h.run(MIGRATIONS.operationsQualificationRows.assert))?.error).toContain(
      `Qualification row ${joinedRow} still has attributionResolution`,
    );
    expect((await h.run(MIGRATIONS.operationsMeetingDailyStats.assert))?.error).toContain(
      `Meeting daily stats row ${daily.without} still has attributionTeamId`,
    );
  });
});
