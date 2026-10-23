import type { Doc, Id } from "../convex/_generated/dataModel";
import {
  closerPipelineHarness,
  insertCloserDeal,
  insertCloserMeeting,
  T0,
} from "./closerPipelineFixtures";

/** Small meeting sequences in index order, including repeated deal IDs. */
export async function closerBoundedReadFixture() {
  const harness = await closerPipelineHarness();
  const seed = await harness.t.run(async (ctx) => {
    const eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
      tenantId: harness.tenantId,
      calendlyEventTypeUri: "https://api.calendly.com/event_types/bounded",
      displayName: "Bounded call",
      createdAt: T0,
    });
    const ownDeal = await insertCloserDeal(ctx, {
      tenantId: harness.tenantId,
      closerId: harness.closerId,
      status: "scheduled",
      createdAt: T0,
      fields: { eventTypeConfigId },
    });
    const reassignedDeal = await insertCloserDeal(ctx, {
      tenantId: harness.tenantId,
      closerId: harness.otherCloserId,
      status: "scheduled",
      createdAt: T0,
      fields: { eventTypeConfigId },
    });
    const meeting = (
      opportunityId: Id<"opportunities">,
      offset: number,
      status: Doc<"meetings">["status"] = "scheduled",
    ) => insertCloserMeeting(ctx, {
      tenantId: harness.tenantId,
      closerId: harness.closerId,
      opportunityId,
      scheduledAt: T0 + offset,
      status,
    });
    const meetings = [
      await meeting(ownDeal, 1, "canceled"),
      await meeting(ownDeal, 2),
      await meeting(reassignedDeal, 3),
    ];
    return { ownDeal, reassignedDeal, eventTypeConfigId, meetings };
  });
  return { harness, seed };
}
