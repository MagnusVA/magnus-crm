import type { Doc, Id } from "../_generated/dataModel";
import type { EntityAttributionPayload } from "../lib/attribution/detailPayload";
import type { CrmRole } from "../lib/roleMapping";

export type LeadCustomerLifecycle = "lead" | "customer" | "merged";
export type LeadCustomerLifecycleFilter = "all" | "lead" | "customer";

export type LeadCustomerSearchRowDto = {
  _id: Id<"leadCustomerSearchRows">;
  leadId: Id<"leads">;
  customerId?: Id<"customers">;
  lifecycle: LeadCustomerLifecycle;
  displayName: string;
  email?: string;
  phone?: string;
  primaryIdentifier?: string;
  leadStatus: "active" | "converted" | "merged";
  customerStatus?: "active" | "churned" | "paused";
  opportunityCount: number;
  wonOpportunityCount: number;
  meetingCount: number;
  latestMeetingAt?: number;
  latestActivityAt: number;
  firstSeenAt: number;
  convertedAt?: number;
  totalPaidMinor?: number;
  paymentCurrency?: string;
  selectedOpportunityId?: Id<"opportunities">;
  selectedMeetingId?: Id<"meetings">;
};

export type RelatedRecordPermissions = {
  canOpenOpportunity: boolean;
  canOpenMeeting: boolean;
  canViewComments: boolean;
  canViewPayments: boolean;
  canRecordPayment: boolean;
};

export type EntityDetailOpportunity = {
  opportunity: {
    _id: Id<"opportunities">;
    leadId: Id<"leads">;
    assignedCloserId?: Id<"users">;
    status: Doc<"opportunities">["status"];
    source?: Doc<"opportunities">["source"];
    firstBookingProgramId?: Id<"tenantPrograms">;
    firstBookingProgramName?: string;
    soldProgramId?: Id<"tenantPrograms">;
    soldProgramName?: string;
    latestMeetingId?: Id<"meetings">;
    latestMeetingAt?: number;
    nextMeetingId?: Id<"meetings">;
    nextMeetingAt?: number;
    firstMeetingId?: Id<"meetings">;
    firstMeetingAt?: number;
    paymentReceivedAt?: number;
    latestActivityAt?: number;
    createdAt: number;
    updatedAt: number;
  };
  closer: Pick<Doc<"users">, "_id" | "fullName" | "email"> | null;
  attribution: EntityAttributionPayload | null;
  permissions: RelatedRecordPermissions;
};

export type EntityDetailPayload = {
  kind: "detail";
  viewer: {
    userId: Id<"users">;
    role: CrmRole;
  };
  lead: Doc<"leads">;
  customer: Doc<"customers"> | null;
  identifiers: Doc<"leadIdentifiers">[];
  opportunities: EntityDetailOpportunity[];
  meetings: Array<
    {
      _id: Id<"meetings">;
      opportunityId: Id<"opportunities">;
      assignedCloserId: Id<"users">;
      scheduledAt: number;
      durationMinutes: number;
      status: Doc<"meetings">["status"];
      callClassification?: Doc<"meetings">["callClassification"];
      completedAt?: number;
      canceledAt?: number;
      bookingProgramName?: string;
      soldProgramName?: string;
      opportunityStatus: Doc<"opportunities">["status"];
      opportunitySource: Doc<"opportunities">["source"];
      permissions: RelatedRecordPermissions;
    }
  >;
  comments: Array<
    Doc<"meetingComments"> & {
      meetingId: Id<"meetings">;
    }
  >;
  payments: Array<{
    _id: Id<"paymentRecords">;
    opportunityId?: Id<"opportunities">;
    meetingId?: Id<"meetings">;
    attributedCloserId?: Id<"users">;
    customerId?: Id<"customers">;
    originatingOpportunityId?: Id<"opportunities">;
    amountMinor: number;
    currency: string;
    commissionable: boolean;
    programId: Id<"tenantPrograms">;
    programName: string;
    paymentType: Doc<"paymentRecords">["paymentType"];
    status: Doc<"paymentRecords">["status"];
    recordedAt: number;
    contextType: Doc<"paymentRecords">["contextType"];
    origin: Doc<"paymentRecords">["origin"];
    permissions: RelatedRecordPermissions;
  }>;
  activity: Array<
    | {
        kind: "opportunity_status";
        at: number;
        opportunityId: Id<"opportunities">;
        status: Doc<"opportunities">["status"];
      }
    | {
        kind: "meeting";
        at: number;
        meetingId: Id<"meetings">;
        status: Doc<"meetings">["status"];
      }
    | {
        kind: "payment";
        at: number;
        paymentId: Id<"paymentRecords">;
        amountMinor: number;
        currency: string;
      }
    | {
        kind: "customer";
        at: number;
        customerId: Id<"customers">;
        status: Doc<"customers">["status"];
      }
  >;
  caps: {
    opportunities: boolean;
    meetings: boolean;
    comments: boolean;
    payments: boolean;
    activity: boolean;
    maxActivity: number;
  };
};

export type EntityDetailResult =
  | EntityDetailPayload
  | { kind: "redirect"; leadId: Id<"leads"> }
  | null;
