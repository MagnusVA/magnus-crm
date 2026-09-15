import { describe, expect, it } from "vitest";
import { leadDashboardOriginsByTeam, leadDashboardOverview, leadDashboardTeams, leadDashboardWorkers } from "./lead-dashboard";

describe("Lead Gen dashboard view model", () => {
  it("preserves worker identities, team grouping, zero schedules and all performance metrics", () => {
    const rows = [{ rowKey: "worker1", payload: {
      workerId: "worker1", label: "Ana", email: "ana@example.test", teamId: "team1", teamLabel: "DM Team A", isActive: true,
      submissions: 42, uniqueProspects: 39, duplicates: 3, scheduledHours: 0, leadsPerHour: null,
      identityId: "worker1", identityName: "Ana", identityEmail: "ana@example.test", identityImageUrl: "https://example.test/avatar.png", identityImageSource: "workos", identitySecondaryLabel: "ana@example.test", identityIsActive: true, identitySource: "crm_user",
    } }];
    expect(leadDashboardWorkers(rows)).toEqual([{
      workerId: "worker1", displayName: "Ana", email: "ana@example.test", teamId: "team1", isActive: true,
      submissions: 42, uniqueProspects: 39, duplicates: 3, scheduledHours: 0, leadsPerHour: null,
      worker: { id: "worker1", name: "Ana", email: "ana@example.test", imageUrl: "https://example.test/avatar.png", imageSource: "workos", secondaryLabel: "ana@example.test", isActive: true, source: "crm_user" },
    }]);
    expect(leadDashboardTeams(rows)).toEqual([{ _id: "team1", name: "DM Team A" }]);
    expect(leadDashboardOverview(rows[0].payload)).toMatchObject({ submissions: 42, scheduledHours: 0, leadsPerHour: null });
  });

  it("ranks the top ten by submissions across all pages, not export unique-prospect order", () => {
    const rows = Array.from({ length: 61 }, (_, i) => ({ rowKey: `origin${i}`, payload: {
      originKey: `origin${i}`, originValue: `https://example.test/${i}`, source: "instagram", originKind: "reel", submissions: i + 1, uniqueProspects: 61 - i,
    } }));
    const ranked = leadDashboardOriginsByTeam(rows)[0].origins;
    expect(ranked).toHaveLength(10);
    expect(ranked[0]).toMatchObject({ originKey: "origin60", submissions: 61, uniqueProspects: 1 });
    expect(ranked[9].originKey).toBe("origin51");
  });
  it("ranks each team independently and keeps shared origins and unassigned counts separate", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ rowKey: `a:${i}`, payload: {
      teamId: "team-a", teamLabel: "Team A", originKey: `origin${i}`, originValue: `https://example.test/${i}`,
      source: "instagram", originKind: "post", submissions: i + 10, uniqueProspects: 1,
    } }));
    const groups = leadDashboardOriginsByTeam([...rows,
      { rowKey: "b:shared", payload: { teamId: "team-b", teamLabel: "Team B", originKey: "origin11", originValue: "https://example.test/11", source: "instagram", originKind: "post", submissions: 2, uniqueProspects: 2 } },
      { rowKey: "unassigned", payload: { originKey: "unassigned", originKind: "reel", submissions: 500, uniqueProspects: 500 } },
      { rowKey: "voided", payload: { teamId: "voided-team", originKind: "post", submissions: 0 } },
      { rowKey: "follower", payload: { teamId: "follower-team", originKind: "follower", submissions: 999 } },
    ]);
    expect(groups.map((group) => group.teamName)).toEqual(["Team A", "Team B", "Unassigned"]);
    expect(groups[0].origins).toHaveLength(10);
    expect(groups[0].origins[0]).toMatchObject({ originKey: "origin11", submissions: 21 });
    expect(groups[1].origins).toHaveLength(1);
    expect(groups[1].origins[0]).toMatchObject({ originKey: "origin11", submissions: 2, uniqueProspects: 2 });
  });
});
