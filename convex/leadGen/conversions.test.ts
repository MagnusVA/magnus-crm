/**
 * Prospect conversion by lead gen worker (docs/plans/phase-2-person-first.md §7).
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

const NOW = Date.parse("2026-10-10T18:00:00Z");

it("credits each worker's prospects, and only the stages reached after the capture", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW - 3_600_000));
  const h = await bookingHarness();
  const installationId = await h.t.run(async (ctx) =>
    await ctx.db.insert("slackInstallations", {
      tenantId: h.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
      appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "r", status: "active",
    }),
  );
  const qualify = async (handle: string, submittedAt: number) => {
    await h.t.mutation(internal.slack.createQualifiedLead.create, {
      tenantId: h.tenantId, installationId, fullName: "Lead", handle, country: "Honduras", leadType: "pt",
      qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt },
    });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  };
  const capture = (handle: string) =>
    h.admin.mutation(api.leadGen.capture.submit, {
      source: "instagram", rawHandleOrProfileUrl: `@${handle}`, originKind: "follower",
    });

  // Qualified before the capture: the worker gets the prospect only.
  await qualify("already.qualified", NOW - 7_200_000);
  await capture("already.qualified");
  // Captured, then qualified: the worker gets both.
  await capture("converts.later");
  await capture("stays.prospect");
  vi.setSystemTime(new Date(NOW));
  await qualify("converts.later", NOW);

  const rows = await h.admin.query(api.leadGen.conversions.listProspectConversions, {
    startDayKey: "2026-10-01",
    endDayKey: "2026-10-31",
  });

  expect(rows.capped).toBe(false);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].counts).toEqual({
    prospect: 3, in_conversation: 1, qualified: 1, booked: 0, showed: 0, customer: 0,
  });
  const outside = await h.admin.query(api.leadGen.conversions.listProspectConversions, {
    startDayKey: "2026-09-01",
    endDayKey: "2026-09-30",
  });
  expect(outside).toEqual({ rows: [], capped: false });
});
