import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import { dumpTables, writtenRows } from "../../tests/writeDump";
import { setTeamBookingQuotaCore } from "../attribution/teams";
import { setTeamDailyGoalCore } from "./slackQualifications";

// The two goal setters split into a guard and a core (admin assistant,
// commit 9). The web snapshots were taken on the handlers before the split.

afterEach(() => vi.useRealTimers());

const MCP = { via: "mcp", agentClient: "claude-ai" } as const;

async function goalHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const harness = await bookingHarness();
  const teamId = await harness.admin.mutation(api.attribution.teams.createTeam, {
    displayName: "Team A",
    utmSource: "team-a",
  });
  const adminId = await harness.t.run(async (ctx) =>
    (await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin"))
      .unique())!._id,
  );
  vi.setSystemTime(new Date("2026-10-20T12:05:00Z"));
  const actor = { userId: adminId, tenantId: harness.tenantId, role: "tenant_admin" as const };
  return { ...harness, teamId, actor };
}

type Harness = Awaited<ReturnType<typeof goalHarness>>;

async function writes(harness: Harness, write: () => Promise<unknown>) {
  const before = await dumpTables(harness.t);
  const result = await write();
  const after = await dumpTables(harness.t);
  return { result, written: writtenRows(before, after) };
}

async function refusal(write: () => Promise<unknown>) {
  try {
    await write();
    return "allowed";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("web paths write what they wrote before the split", () => {
  it("setTeamDailyGoal", async () => {
    const h = await goalHarness();
    expect(
      await writes(h, () =>
        h.admin.mutation(api.reporting.slackQualifications.setTeamDailyGoal, {
          dailyTeamQualificationGoal: 12,
        }),
      ),
    ).toMatchSnapshot();
    expect(
      await writes(h, () =>
        h.admin.mutation(api.reporting.slackQualifications.setTeamDailyGoal, {
          dailyTeamQualificationGoal: null,
        }),
      ),
    ).toMatchSnapshot();
    expect(
      await refusal(() =>
        h.admin.mutation(api.reporting.slackQualifications.setTeamDailyGoal, {
          dailyTeamQualificationGoal: 1.5,
        }),
      ),
    ).toMatchSnapshot();
    expect(
      await refusal(() =>
        h.closer.mutation(api.reporting.slackQualifications.setTeamDailyGoal, {
          dailyTeamQualificationGoal: 3,
        }),
      ),
    ).toMatchSnapshot();
  });

  it("setTeamBookingQuota", async () => {
    const h = await goalHarness();
    expect(
      await writes(h, () =>
        h.admin.mutation(api.attribution.teams.setTeamBookingQuota, {
          teamId: h.teamId,
          bookingDailyQuota: 40,
        }),
      ),
    ).toMatchSnapshot();
    expect(
      await writes(h, () =>
        h.admin.mutation(api.attribution.teams.setTeamBookingQuota, {
          teamId: h.teamId,
          bookingDailyQuota: null,
        }),
      ),
    ).toMatchSnapshot();
    expect(
      await refusal(() =>
        h.admin.mutation(api.attribution.teams.setTeamBookingQuota, {
          teamId: h.teamId,
          bookingDailyQuota: 6000,
        }),
      ),
    ).toMatchSnapshot();
  });
});

describe("cores", () => {
  it("setTeamDailyGoalCore writes what the web writes", async () => {
    const web = await goalHarness();
    const webWrites = await writes(web, () =>
      web.admin.mutation(api.reporting.slackQualifications.setTeamDailyGoal, {
        dailyTeamQualificationGoal: 12,
      }),
    );
    const mcp = await goalHarness();
    const mcpWrites = await writes(mcp, () =>
      mcp.t.run((ctx) => setTeamDailyGoalCore(ctx, mcp.actor, { dailyTeamQualificationGoal: 12 }, MCP)),
    );
    expect(mcpWrites).toEqual(webWrites);
    await expect(
      mcp.t.run((ctx) =>
        setTeamDailyGoalCore(ctx, { ...mcp.actor, role: "closer" }, { dailyTeamQualificationGoal: 12 }, MCP),
      ),
    ).rejects.toThrow("This action isn't available for your role.");
  });

  it("setTeamBookingQuotaCore writes what the web writes", async () => {
    const web = await goalHarness();
    const webWrites = await writes(web, () =>
      web.admin.mutation(api.attribution.teams.setTeamBookingQuota, {
        teamId: web.teamId,
        bookingDailyQuota: 40,
      }),
    );
    const mcp = await goalHarness();
    const mcpWrites = await writes(mcp, () =>
      mcp.t.run((ctx) =>
        setTeamBookingQuotaCore(ctx, mcp.actor, { teamId: mcp.teamId, bookingDailyQuota: 40 }, MCP),
      ),
    );
    expect(mcpWrites).toEqual(webWrites);
  });
});
