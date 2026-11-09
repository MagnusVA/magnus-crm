import { v } from "convex/values";
import { omit } from "convex-helpers";
import schema from "../schema";
import { memberAvatarIdentityValidator as member } from "../lib/memberIdentity";
import {
  dealAttributionValidator,
  dealLabelFields,
  meetingDealLabelFields,
} from "../leadCustomers/detailValidators";

const text = v.union(v.string(), v.null());
export const meetingDetailValidator = v.object({
  meeting: schema.doc("meetings"),
  opportunity: v.object({
    ...schema.doc("opportunities").fields,
    ...dealLabelFields,
    rescheduleLinkPending: v.boolean(),
  }),
  lead: schema.doc("leads"),
  bookingAnswers: v.array(
    v.object({
      fieldKey: v.string(),
      question: v.string(),
      answer: v.string(),
      capturedAt: v.number(),
    }),
  ),
  assignedCloser: v.union(
    v.object({ fullName: v.optional(v.string()), email: v.string() }),
    v.null(),
  ),
  meetingHistory: v.array(
    v.object({
      ...schema.doc("meetings").fields,
      ...meetingDealLabelFields,
      isCurrentMeeting: v.boolean(),
    }),
  ),
  eventTypeName: text,
  paymentLinks: v.union(
    v.array(
      schema.tables.eventTypeConfigs.validator.fields.paymentLinks.element,
    ),
    v.null(),
  ),
  payments: v.array(
    v.object({
      ...omit(schema.doc("paymentRecords").fields, ["attributedCloserId"]),
      amount: v.number(),
      proofFileUrl: text,
      proofFileContentType: text,
      proofFileSize: v.union(v.number(), v.null()),
      attributedCloserId: v.union(v.id("users"), v.null()),
      attributedCloserName: text,
      attributedCloser: v.union(member, v.null()),
      recordedByName: text,
      recordedBy: v.union(member, v.null()),
    }),
  ),
  reassignmentInfo: v.union(
    v.object({
      reassignedFromCloserName: v.string(),
      reassignedAt: v.number(),
      reason: v.string(),
    }),
    v.null(),
  ),
  potentialDuplicate: v.union(
    v.object({
      _id: v.id("leads"),
      fullName: v.optional(v.string()),
      email: v.optional(v.string()),
    }),
    v.null(),
  ),
  rescheduledFromMeeting: v.union(
    v.object({
      _id: v.id("meetings"),
      scheduledAt: v.number(),
      status: schema.tables.meetings.validator.fields.status,
      durationMinutes: v.number(),
    }),
    v.null(),
  ),
  assignedCloserIdentity: v.union(member, v.null()),
  attributionTeam: v.union(schema.doc("attributionTeams"), v.null()),
  dmCloser: v.union(schema.doc("dmClosers"), v.null()),
  dmCloserIdentity: v.union(member, v.null()),
  dealAttribution: dealAttributionValidator,
  activeFollowUp: v.union(
    v.object({
      _id: v.id("followUps"),
      type: schema.tables.followUps.validator.fields.type,
      status: v.literal("pending"),
      createdAt: v.number(),
      reminderScheduledAt: v.optional(v.number()),
      schedulingLinkUrl: v.optional(v.string()),
    }),
    v.null(),
  ),
});
