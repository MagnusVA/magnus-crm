import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatiblePaymentCommissionable,
} from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import type { BillingAuditMetric } from "./types";

const DEFAULT_AUDIT_LIMIT = 200;
const MAX_AUDIT_LIMIT = 500;
const ISSUE_SAMPLE_LIMIT = 25;
const SLACK_CONTRIBUTOR_LIMIT = 25;

type BillingAuditIssue = {
  paymentRecordId: Id<"paymentRecords">;
  issue: BillingAuditMetric | "unresolvedCustomer" | "unresolvedMeeting";
  detail: string;
};

function boundedLimit(limit: number | undefined) {
  return Math.min(
    Math.max(Math.trunc(limit ?? DEFAULT_AUDIT_LIMIT), 1),
    MAX_AUDIT_LIMIT,
  );
}

function tenantOwned<T extends { tenantId: Id<"tenants"> }>(
  doc: T | null,
  tenantId: Id<"tenants">,
): T | null {
  return doc && doc.tenantId === tenantId ? doc : null;
}

function hasAttributionContext(
  opportunity: Doc<"opportunities"> | null,
  meeting: Doc<"meetings"> | null,
) {
  return Boolean(
    opportunity?.qualifiedBy ??
      opportunity?.utmParams ??
      opportunity?.attributionTeamId ??
      opportunity?.dmCloserId ??
      meeting?.utmParams ??
      meeting?.attributionTeamId ??
      meeting?.dmCloserId,
  );
}

export async function buildPaymentAuditSnapshot(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  limit: number | undefined,
) {
  const sampleLimit = boundedLimit(limit);
  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_recordedAt", (q) => q.eq("tenantId", tenantId))
    .order("desc")
    .take(sampleLimit);

  const metrics: Record<BillingAuditMetric, number> = {
    missingCustomerId: 0,
    missingMeetingId: 0,
    missingAttributedCloserOnCommissionable: 0,
    missingRecordedByUser: 0,
    missingProgram: 0,
    missingAttributionContext: 0,
    missingSlackContributorTimeline: 0,
    existingVerifiedRows: 0,
    proofFileRows: 0,
  };
  const byStatus: Record<Doc<"paymentRecords">["status"], number> = {
    recorded: 0,
    verified: 0,
    disputed: 0,
  };
  const issues: BillingAuditIssue[] = [];
  let verifiedRowsMissingReviewer = 0;
  let verifiedRowsMissingReviewedAt = 0;
  let unresolvedSlackContributorUsers = 0;

  const sampleDiagnostics = await Promise.all(
    payments.slice(0, ISSUE_SAMPLE_LIMIT).map(async (payment) => {
      const [recordedBy, program, customer, meetingById] = await Promise.all([
        ctx.db.get(payment.recordedByUserId),
        ctx.db.get(payment.programId),
        payment.customerId ? ctx.db.get(payment.customerId) : Promise.resolve(null),
        payment.meetingId ? ctx.db.get(payment.meetingId) : Promise.resolve(null),
      ]);
      const meeting = tenantOwned(meetingById, tenantId);
      const opportunityId =
        payment.opportunityId ??
        payment.originatingOpportunityId ??
        meeting?.opportunityId;
      const opportunity = opportunityId
        ? tenantOwned(await ctx.db.get(opportunityId), tenantId)
        : null;
      const slackEvents =
        opportunity &&
        (opportunity.source === "slack_qualified" || opportunity.qualifiedBy)
          ? await ctx.db
              .query("slackQualificationEvents")
              .withIndex(
                "by_tenantId_and_opportunityId_and_submittedAt",
                (q) =>
                  q.eq("tenantId", tenantId).eq("opportunityId", opportunity._id),
              )
              .take(SLACK_CONTRIBUTOR_LIMIT)
          : [];

      return {
        paymentRecordId: payment._id,
        status: payment.status,
        recordedAt: payment.recordedAt,
        customer: {
          hasId: payment.customerId !== undefined,
          resolved: customer !== null && customer.tenantId === tenantId,
        },
        meeting: {
          hasId: payment.meetingId !== undefined,
          resolved: meeting !== null,
        },
        recordedByUser: {
          resolved: recordedBy !== null && recordedBy.tenantId === tenantId,
        },
        program: {
          resolved: program !== null && program.tenantId === tenantId,
          archived: program?.archivedAt !== undefined,
        },
        attribution: {
          hasContext: hasAttributionContext(opportunity, meeting),
          slackContributorEvents: slackEvents.length,
        },
        proof: {
          hasProofFile: payment.proofFileId !== undefined,
        },
      };
    }),
  );

  await Promise.all(
    payments.map(async (payment) => {
      byStatus[payment.status] += 1;
      if (payment.status === "verified") {
        metrics.existingVerifiedRows += 1;
        if (payment.verifiedByUserId === undefined) {
          verifiedRowsMissingReviewer += 1;
        }
        if (payment.verifiedAt === undefined) {
          verifiedRowsMissingReviewedAt += 1;
        }
      }
      if (payment.customerId === undefined) {
        metrics.missingCustomerId += 1;
      }
      if (payment.meetingId === undefined) {
        metrics.missingMeetingId += 1;
      }
      if (payment.proofFileId !== undefined) {
        metrics.proofFileRows += 1;
      }
      if (
        resolveLegacyCompatiblePaymentCommissionable(payment) &&
        resolveLegacyCompatibleAttributedCloserId(payment) === undefined
      ) {
        metrics.missingAttributedCloserOnCommissionable += 1;
      }

      const [recordedBy, program, customer, meetingById] = await Promise.all([
        ctx.db.get(payment.recordedByUserId),
        ctx.db.get(payment.programId),
        payment.customerId ? ctx.db.get(payment.customerId) : Promise.resolve(null),
        payment.meetingId ? ctx.db.get(payment.meetingId) : Promise.resolve(null),
      ]);

      if (!recordedBy || recordedBy.tenantId !== tenantId) {
        metrics.missingRecordedByUser += 1;
        if (issues.length < ISSUE_SAMPLE_LIMIT) {
          issues.push({
            paymentRecordId: payment._id,
            issue: "missingRecordedByUser",
            detail: "recordedByUserId does not resolve to a tenant user",
          });
        }
      }
      if (!program || program.tenantId !== tenantId) {
        metrics.missingProgram += 1;
        if (issues.length < ISSUE_SAMPLE_LIMIT) {
          issues.push({
            paymentRecordId: payment._id,
            issue: "missingProgram",
            detail: "programId does not resolve to a tenant program",
          });
        }
      }
      if (payment.customerId && (!customer || customer.tenantId !== tenantId)) {
        if (issues.length < ISSUE_SAMPLE_LIMIT) {
          issues.push({
            paymentRecordId: payment._id,
            issue: "unresolvedCustomer",
            detail: "customerId does not resolve to a tenant customer",
          });
        }
      }

      const meeting = tenantOwned(meetingById, tenantId);
      if (payment.meetingId && !meeting) {
        if (issues.length < ISSUE_SAMPLE_LIMIT) {
          issues.push({
            paymentRecordId: payment._id,
            issue: "unresolvedMeeting",
            detail: "meetingId does not resolve to a tenant meeting",
          });
        }
      }

      const opportunityId =
        payment.opportunityId ??
        payment.originatingOpportunityId ??
        meeting?.opportunityId;
      const opportunity = opportunityId
        ? tenantOwned(await ctx.db.get(opportunityId), tenantId)
        : null;
      if (!hasAttributionContext(opportunity, meeting)) {
        metrics.missingAttributionContext += 1;
      }

      if (
        opportunity &&
        (opportunity.source === "slack_qualified" || opportunity.qualifiedBy)
      ) {
        const slackEvents = await ctx.db
          .query("slackQualificationEvents")
          .withIndex("by_tenantId_and_opportunityId_and_submittedAt", (q) =>
            q.eq("tenantId", tenantId).eq("opportunityId", opportunity._id),
          )
          .take(SLACK_CONTRIBUTOR_LIMIT);

        if (slackEvents.length === 0 && opportunity.qualifiedBy === undefined) {
          metrics.missingSlackContributorTimeline += 1;
        }

        await Promise.all(
          slackEvents.map(async (event) => {
            const slackUser = await ctx.db
              .query("slackUsers")
              .withIndex("by_tenantId_and_slackUserId", (q) =>
                q.eq("tenantId", tenantId).eq("slackUserId", event.slackUserId),
              )
              .first();
            if (!slackUser) {
              unresolvedSlackContributorUsers += 1;
            }
          }),
        );
      }
    }),
  );

  return {
    totalSampled: payments.length,
    sampleLimit,
    metrics,
    byStatus,
    verifiedDiagnostics: {
      existingVerifiedRows: metrics.existingVerifiedRows,
      missingReviewer: verifiedRowsMissingReviewer,
      missingReviewedAt: verifiedRowsMissingReviewedAt,
    },
    slackContributorDiagnostics: {
      unresolvedSlackContributorUsers,
      contributorTimelineLimit: SLACK_CONTRIBUTOR_LIMIT,
    },
    issueSamples: issues,
    sampleDiagnostics,
  };
}

export const getPaymentAuditSnapshot = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return await buildPaymentAuditSnapshot(ctx, tenantId, limit);
  },
});
