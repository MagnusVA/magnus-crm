import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { createRoleFixture, from, identity, split, to } from "../../tests/peopleRolesFixtures";
import { qualifiedLifecycle } from "../../tests/bookingHarness";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(to + 1000); });
afterEach(() => vi.useRealTimers());

const CAPTURES = 3000;
// A busy day: every capture is a new person, so each needs its prospect read.
async function busyDay(limits?: Parameters<typeof createRoleFixture>[0]) {
  const f = await createRoleFixture(limits);
  await f.t.run(async ctx => {
    for (let i = 0; i < CAPTURES; i++) {
      const leadId = await ctx.db.insert("leads", { tenantId: f.tenantId, fullName: `Captured ${i}`, ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0 });
      const at = split + 1000 + i;
      const prospectId = await ctx.db.insert("leadGenProspects", { tenantId: f.tenantId, firstSource: "instagram", latestSource: "instagram", dedupeKey: `p${i}`,
        normalizedHandle: `p${i}`, rawHandle: `p${i}`, profileUrl: "url", firstCapturedByWorkerId: f.workerA, firstCapturedAt: at,
        lastSubmittedByWorkerId: f.workerA, lastSubmittedAt: at, latestOriginKind: "follower", contactAttemptCount: 1,
        distinctWorkerCount: 1, leadId, createdAt: at, updatedAt: at });
      await ctx.db.insert("leadGenSubmissions", { tenantId: f.tenantId, prospectId, workerId: f.workerA, userId: f.closerA, teamId: f.teamId,
        source: "instagram", originKind: "follower", originRankable: false, submittedAt: at, createdAt: at });
    }
  });
  return f;
}

describe("live People lead gen on a busy day", () => {
  it("reads every capture within Convex's limits and names only the listed items", async () => {
    const f = await busyDay();
    const reader = f.t.withIdentity(identity);
    const roster = await reader.query(api.reports.peopleRoles.getLeadGen, { startDate: from, endDate: to });
    expect(roster.isTruncated).toBe(false);
    // The fixture's own two captures, plus the day's.
    expect(roster.rows.find(row => row.teamMemberId === f.memberA)).toMatchObject({ captures: CAPTURES + 2 });
    const member = await reader.query(api.reports.peopleRoles.getLeadGen, { startDate: from, endDate: to, memberId: f.memberA });
    expect(member.isTruncated).toBe(false);
    expect(member.items).toHaveLength(300);
    expect(member.items[0]).toMatchObject({ personName: `Captured ${CAPTURES - 1}` });
  }, 60_000);

  it("stops near a limit and answers partial instead of failing", async () => {
    // Index ranges are db.get and db.query calls; one prospect read per capture.
    const f = await busyDay({ databaseQueries: 1000 });
    const roster = await f.t.withIdentity(identity).query(api.reports.peopleRoles.getLeadGen, { startDate: from, endDate: to });
    expect(roster.isTruncated).toBe(true);
    expect(roster.rows.find(row => row.teamMemberId === f.memberA)?.captures).toBeGreaterThan(0);
  }, 60_000);
});
