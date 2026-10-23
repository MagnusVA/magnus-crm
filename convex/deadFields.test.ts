import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { book, enrollmentHarness } from "../tests/enrollmentFixtures";

afterEach(() => vi.useRealTimers());

it.each(["closer", "admin"] as const)("%s no-show writes meeting times and the E2E snapshot reads them", async (actor) => {
  const h = await enrollmentHarness();
  const { meetingId, opportunityId } = await book(h, `no-show-${actor}`);
  if (actor === "closer") {
    await h.closer.mutation(api.closer.noShowActions.markNoShow, { meetingId, reason: "no_response" });
  } else {
    await h.admin.mutation(api.admin.meetingActions.adminMarkNoShow, { meetingId, reason: "no_response" });
  }
  const { deal, meeting } = await h.t.run(async (ctx) => ({
    deal: await ctx.db.get("opportunities", opportunityId),
    meeting: await ctx.db.get("meetings", meetingId),
  }));
  expect(deal).not.toHaveProperty("noShowAt");
  expect(deal).not.toHaveProperty("canceledAt");
  expect(meeting?.noShowMarkedAt).toBe(Date.now());
  expect(deal?.lostAt).toBe(meeting?.noShowMarkedAt);
  const snapshot = await h.t.query(internal.testing.e2e.getOpportunitySnapshot, { opportunityId });
  expect(snapshot?.opportunity.noShowAt).toBe(meeting?.noShowMarkedAt);
  expect(snapshot?.opportunity.canceledAt).toBeNull();
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
});
