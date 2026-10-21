import type { Id } from "../_generated/dataModel";

export type LeadCustomerLifecycle = "prospect" | "lead" | "customer" | "merged";
export type LeadCustomerLifecycleFilter = "all" | "prospect" | "lead" | "customer";

export type LeadCustomerSearchRowDto = {
  _id: Id<"leadCustomerSearchRows">;
  leadId: Id<"leads">;
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
