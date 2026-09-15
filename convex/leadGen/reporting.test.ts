import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { convexTestModules } from "../test.setup";

async function fixture() {
  const t = convexTest(schema, convexTestModules);
  const ids = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Report test", contactEmail: "test@example.test", workosOrgId: "org_report",
      status: "active", inviteExpiresAt: 0, createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId, workosUserId: "user_report", email: "test@example.test", role: "tenant_admin", isActive: true,
    });
    const teamIds = [];
    for (const name of ["Team A", "Team B"]) {
      teamIds.push(await ctx.db.insert("attributionTeams", {
        tenantId, slug: name, displayName: name, utmSource: name, normalizedUtmSource: name,
        isActive: true, createdAt: 0, updatedAt: 0,
      }));
    }
    for (let i = 0; i < 12; i++) {
      await ctx.db.insert("leadGenTeamOriginStats", {
        tenantId, teamId: teamIds[0], dayKey: "2026-09-15", statKey: `a:${i}`,
        source: "instagram", originKind: "reel", originKey: `post${i}`, originValue: `https://instagram.com/reel/post${i}/`,
        submissions: i + 20, uniqueProspectsSubmitted: 12 - i, updatedAt: 0,
      });
    }
    for (const [i, teamId] of [teamIds[1], undefined].entries()) {
      await ctx.db.insert("leadGenTeamOriginStats", {
        tenantId, teamId, dayKey: "2026-09-15", statKey: `other:${i}`,
        source: "instagram", originKind: "reel", originKey: "post11", originValue: "https://instagram.com/reel/post11/",
        submissions: 2, uniqueProspectsSubmitted: 1, updatedAt: 0,
      });
    }
    await ctx.db.insert("leadGenTeamOriginStats", {
      tenantId, teamId: teamIds[0], dayKey: "2026-09-15", statKey: "voided",
      source: "instagram", originKind: "post", originKey: "voided", originValue: "https://instagram.com/p/voided/",
      submissions: 0, uniqueProspectsSubmitted: 0, updatedAt: 0,
    });
    return { teamIds, tenantId };
  });
  return { t, caller: t.withIdentity({ subject: "user_report", org_id: "org_report" }), ...ids };
}

const range = { startDayKey: "2026-09-15", endDayKey: "2026-09-15" };

describe("top posts by team", () => {
  it("takes ten per team after ranking by submissions and keeps shared posts separate", async () => {
    const { caller, teamIds } = await fixture();
    const groups = await caller.query(api.leadGen.reporting.listTopOriginsByTeam, {
      ...range, limitPerTeam: 10, sortBy: "submissions",
    });
    const a = groups.find((group) => group.teamId === teamIds[0])!;
    const b = groups.find((group) => group.teamId === teamIds[1])!;
    expect(a.origins).toHaveLength(10);
    expect(a.origins[0]).toMatchObject({ originKey: "post11", submissions: 31, uniqueProspects: 1 });
    expect(a.origins[9].originKey).toBe("post2");
    expect(b.origins).toHaveLength(1);
    expect(b.origins[0]).toMatchObject({ originKey: "post11", submissions: 2, uniqueProspects: 1 });
    expect(groups.find((group) => group.teamId === null)?.teamName).toBe("Unassigned");
  });

  it("preserves default unique-prospect ranking and applies date, source and team filters", async () => {
    const { caller, teamIds } = await fixture();
    const groups = await caller.query(api.leadGen.reporting.listTopOriginsByTeam, { ...range, teamId: teamIds[0] });
    expect(groups).toHaveLength(1);
    expect(groups[0].origins[0].originKey).toBe("post0");
    expect(await caller.query(api.leadGen.reporting.listTopOriginsByTeam, { ...range, source: "meta_business" })).toEqual([]);
    expect(await caller.query(api.leadGen.reporting.listTopOriginsByTeam, { startDayKey: "2026-09-14", endDayKey: "2026-09-14" })).toEqual([]);
  });

  it("requires tenant admin access", async () => {
    const { t } = await fixture();
    await expect(t.query(api.leadGen.reporting.listTopOriginsByTeam, range)).rejects.toThrow("Not authenticated");
    await expect(t.withIdentity({ subject: "user_report", org_id: "org_other" }).query(api.leadGen.reporting.listTopOriginsByTeam, range)).rejects.toThrow("Organization mismatch");
  });
});


it("selects snapshot fallback when team origins overflow despite a small global scan", async () => {
  const { t, caller, teamIds, tenantId } = await fixture();
  await t.run(async (ctx) => {
    for (let i = 0; i < 400; i++) {
      const origin = {
        tenantId, dayKey: "2026-09-15", source: "instagram" as const,
        originKind: "reel" as const, originKey: `overflow${i}`,
        originValue: `https://instagram.com/reel/overflow${i}/`,
        submissions: 1, uniqueProspectsSubmitted: 1, updatedAt: 0,
      };
      await ctx.db.insert("leadGenOriginStats", origin);
      for (const teamId of [...teamIds, undefined]) {
        await ctx.db.insert("leadGenTeamOriginStats", {
          ...origin, teamId, statKey: `${teamId}:${i}`,
        });
      }
    }
  });
  expect(await caller.query(api.leadGen.reporting.listTopOrigins, { ...range, limit: 10 })).toHaveLength(10);
  expect(await caller.query(api.leadGen.reporting.getOverview, range)).toMatchObject({ capped: true });
  await expect(caller.query(api.leadGen.reporting.listTopOriginsByTeam, range)).rejects.toThrow("Posts by team report is too large");
  // Smaller indexed scopes must remain live even when the tenant-wide scan overflows.
  for (const filters of [
    { teamId: teamIds[0] },
    { source: "meta_business" as const },
    { teamId: teamIds[0], source: "instagram" as const },
    { startDayKey: "2026-09-14", endDayKey: "2026-09-14" },
  ]) {
    expect(await caller.query(api.leadGen.reporting.getOverview, { ...range, ...filters })).toMatchObject({ capped: false });
    await caller.query(api.leadGen.reporting.listTopOriginsByTeam, { ...range, ...filters });
  }
});

it.each(["2026-09-15", "2026-09-30"])("matches live team rankings after the background report completes through %s", async (endDayKey) => {
  const { t, caller, tenantId, teamIds } = await fixture();
  await t.run(async (ctx) => {
    await ctx.db.insert("leadGenTeamOriginStats", {
      tenantId, teamId: teamIds[0], dayKey: "2026-09-20", statKey: "later-post11",
      source: "instagram", originKind: "reel", originKey: "post11",
      originValue: "https://instagram.com/reel/post11/", submissions: 5, uniqueProspectsSubmitted: 2, updatedAt: 0,
    });
  });
  const live = await caller.query(api.leadGen.reporting.listTopOriginsByTeam, {
    ...range, endDayKey, sortBy: "submissions", limitPerTeam: 10,
  });
  expect(live[0].origins[0].submissions).toBe(endDayKey === "2026-09-15" ? 31 : 36);
  const { jobId } = await caller.mutation(api.operations.reports.jobs.requestDashboardReport, {
    reportKind: "lead-gen",
    range: { kind: "custom", startBusinessDate: range.startDayKey, endBusinessDateInclusive: endDayKey },
    requestToken: `team-origins-${endDayKey}`,
  });
  for (let step = 0; step < 30; step++) {
    await t.action(internal.operations.reports.worker.run, { jobId });
    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    if (job?.status === "ready") break;
    expect(job?.status).toBe("queued");
  }
  expect((await t.run(async (ctx) => await ctx.db.get(jobId)))?.status).toBe("ready");
  const rows = [];
  let cursor: string | null = null;
  for (;;) {
    const result: FunctionReturnType<typeof api.operations.reports.jobs.listDashboardReportRows> = await caller.query(api.operations.reports.jobs.listDashboardReportRows, {
      jobId, section: "lead_gen_team_origin", paginationOpts: { cursor, numItems: 2 },
    });
    rows.push(...result.page);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  expect(rows.length).toBeGreaterThan(2);
  expect(new Set(rows.map((row) => row.payload.teamId ?? null))).toEqual(new Set(live.map((group) => group.teamId)));
  for (const group of live) {
    const teamRows = rows.filter((row) => (row.payload.teamId ?? null) === group.teamId);
    expect(teamRows.reduce((sum, row) => sum + Number(row.payload.submissions), 0)).toBe(group.totalSubmissions);
    for (const origin of group.origins) {
      expect(teamRows.map((row) => row.payload)).toContainEqual(expect.objectContaining({
        teamLabel: group.teamId === null ? "No Team" : group.teamName, originKey: origin.originKey,
        originValue: origin.originValue, originKind: origin.originKind, source: origin.source,
        submissions: origin.submissions, uniqueProspects: origin.uniqueProspects,
      }));
    }
  }
});
