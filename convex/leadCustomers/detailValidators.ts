import { v } from "convex/values";
import { pick } from "convex-helpers";
import { literals } from "convex-helpers/validators";
import schema from "../schema";
import { memberAvatarIdentityValidator as member } from "../lib/memberIdentity";
import { touchSnapshotValidator } from "../lib/touchValidators";
import { lastTouchValidator } from "../lib/respark/validators";
import {
  dealAttributionRoleValidator,
  dealAttributionSourceValidator,
} from "../lib/attribution/validators";
import {
  DEAL_POSITIONS,
  dealStageValidator,
  dealOutcomeValidator,
} from "../opportunities/stages";
import { dealNextStepValidator } from "../closer/pipelineDeals";

const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());
export const dealLabelFields = {
  stage: dealStageValidator,
  outcome: dealOutcomeValidator,
  position: literals(...DEAL_POSITIONS),
  systemLoss: v.union(v.null(), literals("stale", "no_show", "canceled")),
};
export const meetingDealLabelFields = {
  dealStage: dealStageValidator,
  dealOutcome: dealOutcomeValidator,
  dealPosition: dealLabelFields.position,
  dealSystemLoss: dealLabelFields.systemLoss,
};
const touch = v.object({
  ...touchSnapshotValidator.fields,
  teamMemberName: nullableString,
  teamMember: v.union(member, v.null()),
});
const attributionFields = {
  credits: v.array(
    v.object({
      id: v.id("dealAttributions"),
      role: dealAttributionRoleValidator,
      name: nullableString,
      identity: v.union(member, v.null()),
      sourceKind: v.union(
        ...dealAttributionSourceValidator.members.map(
          (value) => value.fields.kind,
        ),
      ),
      meetingId: v.union(v.id("meetings"), v.null()),
      attributedAt: v.number(),
    }),
  ),
  firstTouch: v.union(touch, v.null()),
  latestTouch: v.union(touch, v.null()),
};
export const dealAttributionValidator = v.object(attributionFields);
const program = v.union(
  v.object({ id: v.id("tenantPrograms"), name: v.string() }),
  v.null(),
);
const entityAttributionValidator = v.object({
  ...attributionFields,
  slackQualification: v.union(
    v.object({
      slackUserId: v.string(),
      slackUserLabel: v.string(),
      slackUser: member,
      submittedAt: v.number(),
      resultKind:
        schema.tables.slackQualificationEvents.validator.fields.resultKind,
    }),
    v.null(),
  ),
  bookedProgram: program,
  soldProgram: program,
  dmAttribution: v.object({
    status: literals("mapped", "unmapped", "internal", "none"),
    teamName: nullableString,
    dmCloserName: nullableString,
    dmCloser: v.union(member, v.null()),
    rawSource: nullableString,
    rawMedium: nullableString,
  }),
  phoneCloser: v.union(
    v.object({ id: v.id("users"), name: v.string(), identity: member }),
    v.null(),
  ),
  timeline: v.object({
    qualifiedAt: nullableNumber,
    firstBookedAt: nullableNumber,
    firstMeetingAt: nullableNumber,
    paymentReceivedAt: nullableNumber,
  }),
});
const permissions = v.object({
  canOpenOpportunity: v.boolean(),
  canOpenMeeting: v.boolean(),
  canViewComments: v.boolean(),
  canViewPayments: v.boolean(),
  canRecordPayment: v.boolean(),
});
const compactDeal = v.object({
  ...pick(schema.doc("opportunities").fields, [
    "_id",
    "leadId",
    "assignedCloserId",
    "source",
    "firstBookingProgramId",
    "firstBookingProgramName",
    "soldProgramId",
    "soldProgramName",
    "latestMeetingId",
    "latestMeetingAt",
    "nextMeetingId",
    "nextMeetingAt",
    "firstMeetingId",
    "firstMeetingAt",
    "paymentReceivedAt",
    "lostReason",
    "lostAt",
    "latestActivityAt",
    "createdAt",
    "updatedAt",
  ]),
  ...dealLabelFields,
});
const compactMeeting = v.object({
  ...pick(schema.doc("meetings").fields, [
    "_id",
    "opportunityId",
    "assignedCloserId",
    "scheduledAt",
    "durationMinutes",
    "status",
    "callClassification",
    "heldMarkedAt",
    "canceledAt",
    "bookingProgramName",
    "soldProgramName",
  ]),
  ...meetingDealLabelFields,
  opportunitySource: literals("calendly", "slack_qualified", "side_deal"),
  permissions,
});
const compactPayment = v.object({
  ...pick(schema.doc("paymentRecords").fields, [
    "_id",
    "opportunityId",
    "meetingId",
    "attributedCloserId",
    "amountMinor",
    "currency",
    "programId",
    "programName",
    "paymentType",
    "status",
    "recordedAt",
    "origin",
  ]),
  permissions,
});
const paidFields = {
  totalPaidMinor: nullableNumber,
  currency: nullableString,
  paymentCount: v.number(),
};
const customerStatus = literals("active", "paused", "churned");
export const entityDetailValidator = v.union(
  v.null(),
  v.object({ kind: v.literal("redirect"), leadId: v.id("leads") }),
  v.object({
    kind: v.literal("detail"),
    viewer: v.object({
      userId: v.id("users"),
      role: schema.tables.users.validator.fields.role,
    }),
    lead: schema.doc("leads"),
    firstTouch: attributionFields.firstTouch,
    latestTouch: attributionFields.latestTouch,
    enrollments: v.array(
      v.object({
        ...paidFields,
        enrollmentId: v.id("enrollments"),
        programId: v.id("tenantPrograms"),
        programName: v.string(),
        status: customerStatus,
        enrolledAt: v.number(),
        opportunityId: v.id("opportunities"),
        statusChangedAt: nullableNumber,
        statusChangedBy: v.union(
          v.object({ userId: v.id("users"), name: nullableString }),
          v.null(),
        ),
      }),
    ),
    customerSummary: v.union(
      v.object({
        ...paidFields,
        status: customerStatus,
        customerSince: v.number(),
        programNames: v.array(v.string()),
        winningOpportunityId: v.id("opportunities"),
      }),
      v.null(),
    ),
    identifiers: v.array(schema.doc("leadIdentifiers")),
    opportunities: v.array(
      v.object({
        opportunity: compactDeal,
        closer: v.union(
          v.object({
            _id: v.id("users"),
            fullName: v.optional(v.string()),
            email: v.string(),
            avatar: member,
          }),
          v.null(),
        ),
        attribution: v.union(entityAttributionValidator, v.null()),
        permissions,
        nextStep: v.union(
          v.object({
            ...dealNextStepValidator.fields,
            taskId: v.union(v.id("followUps"), v.null()),
            canSet: v.boolean(),
          }),
          v.null(),
        ),
      }),
    ),
    meetings: v.array(compactMeeting),
    comments: v.array(schema.doc("meetingComments")),
    payments: v.array(compactPayment),
    caps: v.object({
      opportunities: v.boolean(),
      meetings: v.boolean(),
      comments: v.boolean(),
      payments: v.boolean(),
    }),
    lastTouch: v.union(
      v.object({ ...lastTouchValidator.fields, label: v.string() }),
      v.null(),
    ),
    inactiveAfterDays: v.number(),
    businessTimeZone: v.string(),
  }),
);
