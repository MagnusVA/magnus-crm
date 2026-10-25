import { v } from "convex/values";
import { dispositionValidator, lifecycleStageValidator } from "../../leads/lifecycle";
import { dealOutcomeValidator, dealStageValidator } from "../../opportunities/stages";
import { resparkResultValidator } from "./validators";

const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());
const result = v.union(resparkResultValidator, v.null());
const touch = v.object({ eventId: v.id("domainEvents"), eventType: v.string(),
  label: v.string(), occurredAt: v.number() });
const deal = v.object({ opportunityId: v.id("opportunities"), stage: dealStageValidator,
  outcome: dealOutcomeValidator, lostReason: nullableString, createdAt: v.number() });
const personCard = v.object({
  handle: nullableString, stage: lifecycleStageValidator, disposition: dispositionValidator,
  capturedAt: nullableNumber, capturedBy: nullableString, qualifiedAt: nullableNumber,
  newestDeal: v.union(deal, v.null()), timeZone: nullableString,
  lastTouches: v.array(touch), capped: v.boolean(),
});
export const batchValidator = v.object({
  batchId: v.id("resparkBatches"), heldUntil: v.number(), size: v.number(), createdAt: v.number(),
  items: v.array(v.object({ itemId: v.id("resparkBatchItems"), position: v.number(), bucket: v.number(),
    result, workedAt: nullableNumber, person: v.union(personCard, v.null()), blockedReason: nullableString })),
  capped: v.boolean(),
});
export const panelValidator = v.object({
  handle: nullableString, stage: lifecycleStageValidator, disposition: dispositionValidator,
  dispositionReason: nullableString,
  identity: v.object({ name: nullableString, phone: nullableString, email: nullableString }),
  timeZone: nullableString, timeline: v.array(touch), deals: v.array(deal),
  calls: v.array(v.object({ meetingId: v.id("meetings"), opportunityId: v.id("opportunities"),
    scheduledAt: v.number(), durationMinutes: v.number(),
    status: v.union(v.literal("scheduled"), v.literal("held"), v.literal("canceled"), v.literal("no_show")),
    bookingAnswers: v.array(v.object({ question: v.string(), answer: v.string() })) })),
  notes: v.array(v.object({ noteId: v.id("leadNotes"), content: v.string(), createdAt: v.number() })),
  resparkHistory: v.array(v.object({ itemId: v.id("resparkBatchItems"), result,
    workedAt: nullableNumber, bucket: v.number() })),
  capped: v.boolean(),
});
