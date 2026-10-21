import type { Doc, Id } from "../_generated/dataModel";
import type { CrmRole } from "../lib/roleMapping";

export function isAdminRole(role: CrmRole) {
  return role === "tenant_master" || role === "tenant_admin";
}

export function canOpenOpportunityDetail(input: {
  viewerUserId: Id<"users">;
  viewerRole: CrmRole;
  opportunity: Doc<"opportunities">;
}) {
  if (isAdminRole(input.viewerRole)) {
    return true;
  }
  return input.opportunity.assignedCloserId === input.viewerUserId;
}

export function canOpenMeetingDetail(input: {
  viewerUserId: Id<"users">;
  viewerRole: CrmRole;
  meeting: Doc<"meetings">;
}) {
  if (isAdminRole(input.viewerRole)) {
    return true;
  }
  return input.meeting.assignedCloserId === input.viewerUserId;
}

export function canViewPaymentDetail(input: {
  viewerUserId: Id<"users">;
  viewerRole: CrmRole;
  payment: Doc<"paymentRecords">;
  opportunityById: Map<Id<"opportunities">, Doc<"opportunities">>;
}) {
  if (isAdminRole(input.viewerRole)) {
    return true;
  }
  if (input.payment.attributedCloserId === input.viewerUserId) {
    return true;
  }

  // Every payment is a deal payment (docs/plans/phase-4-customers.md D12).
  const opportunity = input.payment.opportunityId
    ? input.opportunityById.get(input.payment.opportunityId)
    : undefined;

  return opportunity?.assignedCloserId === input.viewerUserId;
}

export function relatedRecordPermissions(input: {
  canOpenOpportunity?: boolean;
  canOpenMeeting?: boolean;
  canViewComments?: boolean;
  canViewPayments?: boolean;
  canRecordPayment?: boolean;
}) {
  return {
    canOpenOpportunity: input.canOpenOpportunity ?? false,
    canOpenMeeting: input.canOpenMeeting ?? false,
    canViewComments: input.canViewComments ?? false,
    canViewPayments: input.canViewPayments ?? false,
    canRecordPayment: input.canRecordPayment ?? false,
  };
}
