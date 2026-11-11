import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { getErrorMessage } from "../../lib/errors";
import { guardDealIn, guardHarness, readGuardDeal } from "../../tests/dealGuardFixtures";
import { api } from "../_generated/api";

const CALENDAR_URL = "https://calendly.com/closer/call";
const CALENDAR_MISSING = {
  code: "calendar.personal_not_configured",
  message: "No personal calendar configured. Ask your admin to assign one in Team settings.",
};

describe("personal calendar rejections", () => {
  it("createNoShowRescheduleLink rejects a missing calendar without writing, and succeeds with one", async () => {
    const harness = await guardHarness();
    const { t, closer, closerId } = harness;
    const { opportunityId, meetingId } = await guardDealIn(harness, {
      label: "no-show closed deal", status: "no_show", source: "calendly",
    }, { meeting: "no_show" });
    const before = await readGuardDeal(harness, opportunityId);
    await t.run((ctx) => ctx.db.patch("users", closerId, { personalEventTypeUri: undefined }));

    const error = await closer.mutation(api.closer.noShowActions.createNoShowRescheduleLink, {
      opportunityId, meetingId: meetingId!,
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ConvexError);
    expect(error instanceof ConvexError ? error.data : undefined).toEqual(CALENDAR_MISSING);
    expect(getErrorMessage(error, "fallback")).toBe(CALENDAR_MISSING.message);
    expect(await t.run((ctx) => ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", opportunityId))
      .first())).toBeNull();
    expect((await readGuardDeal(harness, opportunityId)).stage).toBe(before.stage);

    await t.run((ctx) => ctx.db.patch("users", closerId, { personalEventTypeUri: CALENDAR_URL }));
    const result = await closer.mutation(api.closer.noShowActions.createNoShowRescheduleLink, {
      opportunityId, meetingId: meetingId!,
    });
    expect(await t.run((ctx) => ctx.db.get("followUps", result.followUpId))).toMatchObject({
      opportunityId, status: "pending", reason: "no_show_follow_up",
      schedulingLinkUrl: result.schedulingLinkUrl,
    });
    expect((await readGuardDeal(harness, opportunityId)).stage).toBe("follow_up");
  });

  it("createSchedulingLinkFollowUp rejects a missing calendar without writing, and succeeds with one", async () => {
    const harness = await guardHarness();
    const { t, closer, closerId } = harness;
    const { opportunityId } = await guardDealIn(harness, {
      label: "scheduled deal", status: "scheduled", source: "calendly",
    });
    const before = await readGuardDeal(harness, opportunityId);
    await t.run((ctx) => ctx.db.patch("users", closerId, { personalEventTypeUri: undefined }));

    const error = await closer.mutation(api.closer.followUpMutations.createSchedulingLinkFollowUp, {
      opportunityId,
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ConvexError);
    expect(error instanceof ConvexError ? error.data : undefined).toEqual(CALENDAR_MISSING);
    expect(getErrorMessage(error, "fallback")).toBe(CALENDAR_MISSING.message);
    expect(await t.run((ctx) => ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", opportunityId))
      .first())).toBeNull();
    expect((await readGuardDeal(harness, opportunityId)).stage).toBe(before.stage);

    await t.run((ctx) => ctx.db.patch("users", closerId, { personalEventTypeUri: CALENDAR_URL }));
    const result = await closer.mutation(api.closer.followUpMutations.createSchedulingLinkFollowUp, {
      opportunityId,
    });
    expect(await t.run((ctx) => ctx.db.get("followUps", result.followUpId))).toMatchObject({
      opportunityId, status: "pending", reason: "closer_initiated",
      schedulingLinkUrl: result.schedulingLinkUrl,
    });
    expect((await readGuardDeal(harness, opportunityId)).stage).toBe("follow_up");
  });
});
