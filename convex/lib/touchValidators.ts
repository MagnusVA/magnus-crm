import { v } from "convex/values";

// docs/plans/phase-3-attribution.md §3.2 and §4.5. Where a touch came from.
export const touchChannelValidator = v.union(
  v.literal("lead_gen"),
  v.literal("dm_portal"),
  v.literal("slack"),
  v.literal("calendly"),
  v.literal("side_deal"),
);

// One touch, by its event. Who made it is the event's team member (or, for a
// Calendly booking, the booking's dm_closer row), so a team member merge never
// leaves a snapshot pointing at a deleted team member.
export const touchSnapshotValidator = v.object({
  eventId: v.id("domainEvents"),
  eventType: v.string(),
  channel: touchChannelValidator,
  occurredAt: v.number(),
});
