import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { leadDisplayString } from "../lib/leadDisplay";
import { rejectRequest } from "../lib/observability/errors";
import { refreshOpportunitySearchForLead } from "../lib/opportunitySearch";
import { syncLeadMeetingNames } from "../lib/syncLeadMeetingNames";
import { rebuildQualificationRow } from "../operations/projections";
import { requireTenantUser } from "../requireTenantUser";
import { buildLeadSearchText } from "./searchTextBuilder";

// An admin corrects a person's name on the person page, and with it the name
// a Slack qualifier typed on that person's submissions. A qualifier who pastes
// the wrong text into the Name field leaves it on the submission, which the
// Qualifications list, reports and Slack reminders show.

const NAME_MAX_LENGTH = 200;
const SUBMISSION_LIMIT = 50;

/** The person's Slack submissions, newest first, with the name each was sent under. */
export const listQualificationNames = query({
  args: { leadId: v.id("leads") },
  returns: v.array(
    v.object({
      qualificationEventId: v.id("slackQualificationEvents"),
      fullNameSnapshot: v.string(),
      submittedAt: v.number(),
    }),
  ),
  handler: async (ctx, { leadId }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const lead = await ctx.db.get("leads", leadId);
    if (!lead || lead.tenantId !== tenantId) {
      return [];
    }
    const events = await ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .order("desc")
      .take(SUBMISSION_LIMIT);
    return events.map((event) => ({
      qualificationEventId: event._id,
      fullNameSnapshot: event.fullNameSnapshot,
      submittedAt: event.submittedAt,
    }));
  },
});

/**
 * Sets the person's name and, for each submission the admin picked, the name
 * on that submission. Updates every copy of the name: the person's search
 * text, their deals' search rows, their meetings, the lead/customer row and
 * the Qualifications rows.
 */
export const renamePerson = mutation({
  args: {
    leadId: v.id("leads"),
    fullName: v.string(),
    qualificationEventIds: v.array(v.id("slackQualificationEvents")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const fullName = args.fullName.trim();
    if (fullName.length === 0 || fullName.length > NAME_MAX_LENGTH) {
      throw rejectRequest(
        "lead_name.invalid",
        `Give a name of 1 to ${NAME_MAX_LENGTH} characters.`,
        { tenantId },
      );
    }
    const lead = await ctx.db.get("leads", args.leadId);
    if (!lead || lead.tenantId !== tenantId) {
      throw rejectRequest("lead_name.lead_not_found", "Lead not found.", { tenantId, leadId: args.leadId });
    }
    if (lead.status === "merged") {
      throw rejectRequest("lead_name.lead_merged", "This lead was merged into another one.", {
        tenantId,
        leadId: lead._id,
      });
    }

    const picked = new Set(args.qualificationEventIds);
    if (picked.size > SUBMISSION_LIMIT) {
      throw rejectRequest("lead_name.too_many_submissions", "Too many submissions picked.", { tenantId });
    }
    for (const eventId of picked) {
      const event = await ctx.db.get("slackQualificationEvents", eventId);
      if (!event || event.tenantId !== tenantId || event.leadId !== lead._id) {
        throw rejectRequest(
          "lead_name.submission_not_found",
          "A picked submission doesn't belong to this person.",
          { tenantId, leadId: lead._id },
        );
      }
      if (event.fullNameSnapshot !== fullName) {
        await ctx.db.patch("slackQualificationEvents", eventId, { fullNameSnapshot: fullName });
      }
    }

    if (lead.fullName !== fullName) {
      await ctx.db.patch("leads", lead._id, { fullName, updatedAt: Date.now() });
    }
    await refreshLeadNameCopies(ctx, tenantId, lead._id);
    return null;
  },
});

/** Rewrites every copy of the person's name after it or a submission's name changed. */
export async function refreshLeadNameCopies(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
) {
  const lead = await ctx.db.get("leads", leadId);
  if (!lead) {
    return;
  }
  const identifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
    .take(100);
  const searchText = buildLeadSearchText(
    lead,
    identifiers.map((identifier) => identifier.value),
  );
  if (searchText !== lead.searchText) {
    await ctx.db.patch("leads", leadId, { searchText });
  }
  await refreshOpportunitySearchForLead(ctx, tenantId, leadId);
  await syncLeadMeetingNames(ctx, tenantId, leadId, leadDisplayString(lead, identifiers));
  await rebuildLeadCustomerSearchRow(ctx, tenantId, leadId);

  // A Qualifications row searches by the submission's name and the person's.
  const events = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .take(SUBMISSION_LIMIT);
  for (const event of events) {
    await rebuildQualificationRow(ctx, event._id);
  }
}
