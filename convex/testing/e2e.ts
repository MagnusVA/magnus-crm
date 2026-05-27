import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

// ---------------------------------------------------------------------------
// E2E test helpers
//
// Focused, read-only queries used by `scripts/e2e-login-url.mjs` callers,
// Playwright fixtures, and AI agents to discover tenant context and inspect
// the records produced by a test booking. These helpers are intentionally
// narrow: they return only the fields a test runner needs so we do not have
// to scrape large `npx convex data` dumps.
//
// All helpers are `internalQuery` and therefore not exposed to the WorkOS
// authenticated app surface; they can only be called via:
//
//   npx convex run testing/e2e:<name> '<args>'
//
// or via a server-side `internal.testing.e2e.*` reference. See
// `brainstorming/AGENT_E2E_TESTING.md` and `AGENT_TESTING.md`.
// ---------------------------------------------------------------------------

/**
 * Look up a tenant by its WorkOS organization id. The returned shape is
 * trimmed to the identity and lifecycle fields a test runner needs.
 */
export const getTenantByWorkosOrgId = internalQuery({
	args: { workosOrgId: v.string() },
	handler: async (ctx, { workosOrgId }) => {
		const tenant = await ctx.db
			.query("tenants")
			.withIndex("by_workosOrgId", (q) =>
				q.eq("workosOrgId", workosOrgId),
			)
			.unique();

		if (!tenant) return null;

		return {
			tenantId: tenant._id,
			companyName: tenant.companyName,
			contactEmail: tenant.contactEmail,
			workosOrgId: tenant.workosOrgId,
			status: tenant.status,
			tenantOwnerId: tenant.tenantOwnerId ?? null,
			onboardingCompletedAt: tenant.onboardingCompletedAt ?? null,
			billingOpsEnabled: tenant.billingOpsEnabled ?? false,
		};
	},
});

/**
 * Return the active CRM users for a tenant with just enough context for
 * mapping role aliases (closer1/owner) to assigned closer emails.
 * Capped at 100 users — sufficient for any realistic test tenant.
 */
export const getTestUserMap = internalQuery({
	args: { tenantId: v.id("tenants") },
	handler: async (ctx, { tenantId }) => {
		const users = await ctx.db
			.query("users")
			.withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
			.take(100);

		return users.map((user) => ({
			userId: user._id,
			email: user.email,
			fullName: user.fullName ?? null,
			role: user.role,
			calendlyUserUri: user.calendlyUserUri ?? null,
			calendlyMemberName: user.calendlyMemberName ?? null,
			isActive: user.isActive,
			invitationStatus: user.invitationStatus ?? null,
		}));
	},
});

/**
 * Return the latest opportunity + meeting + assigned closer produced by a
 * Calendly booking for a given invitee email. Used as the polling target
 * after `testing/calendly:bookTestInvitee` to confirm the webhook landed
 * before opening the browser.
 *
 * Returns null when the lead has not yet been created. Returns
 * `{ lead, opportunity: null, meeting: null, assignedCloser: null }` when
 * the lead exists but no opportunity has been created yet.
 *
 * The lead is matched via the `by_tenantId_and_email` index. If multiple
 * leads exist for the same email (rare — usually only after a merge), the
 * most recently created lead is returned.
 */
export const getBookingResultByInviteeEmail = internalQuery({
	args: {
		tenantId: v.id("tenants"),
		inviteeEmail: v.string(),
	},
	handler: async (ctx, { tenantId, inviteeEmail }) => {
		const email = inviteeEmail.trim().toLowerCase();
		if (!email) return null;

		const leadCandidates = await ctx.db
			.query("leads")
			.withIndex("by_tenantId_and_email", (q) =>
				q.eq("tenantId", tenantId).eq("email", email),
			)
			.take(10);

		if (leadCandidates.length === 0) return null;

		const lead = leadCandidates
			.slice()
			.sort((a, b) => b._creationTime - a._creationTime)[0];

		const opportunities = await ctx.db
			.query("opportunities")
			.withIndex("by_tenantId_and_leadId", (q) =>
				q.eq("tenantId", tenantId).eq("leadId", lead._id),
			)
			.take(10);

		const opportunity = opportunities
			.slice()
			.sort((a, b) => b._creationTime - a._creationTime)[0];

		const leadShape = {
			id: lead._id,
			email: lead.email ?? null,
			fullName: lead.fullName ?? null,
			phone: lead.phone ?? null,
			customFields: lead.customFields ?? null,
			status: lead.status,
			socialHandles: lead.socialHandles ?? null,
		};

		if (!opportunity) {
			return {
				lead: leadShape,
				opportunity: null,
				meeting: null,
				assignedCloser: null,
			};
		}

		const meetings = await ctx.db
			.query("meetings")
			.withIndex("by_opportunityId", (q) =>
				q.eq("opportunityId", opportunity._id),
			)
			.take(10);

		const meeting = meetings
			.slice()
			.sort((a, b) => b._creationTime - a._creationTime)[0] ?? null;

		const assignedCloser = opportunity.assignedCloserId
			? await ctx.db.get(opportunity.assignedCloserId)
			: null;

		return {
			lead: leadShape,
			opportunity: {
				id: opportunity._id,
				status: opportunity.status,
				source: opportunity.source ?? null,
				assignedCloserId: opportunity.assignedCloserId ?? null,
				latestMeetingId: opportunity.latestMeetingId ?? null,
				latestMeetingAt: opportunity.latestMeetingAt ?? null,
				nextMeetingId: opportunity.nextMeetingId ?? null,
				nextMeetingAt: opportunity.nextMeetingAt ?? null,
				utmParams: opportunity.utmParams ?? null,
				attributionResolution:
					opportunity.attributionResolution ?? null,
				eventTypeConfigId: opportunity.eventTypeConfigId ?? null,
				createdAt: opportunity.createdAt,
			},
			meeting: meeting
				? {
						id: meeting._id,
						status: meeting.status,
						scheduledAt: meeting.scheduledAt,
						durationMinutes: meeting.durationMinutes,
						assignedCloserId: meeting.assignedCloserId,
						calendlyEventUri: meeting.calendlyEventUri,
						calendlyInviteeUri: meeting.calendlyInviteeUri,
						utmParams: meeting.utmParams ?? null,
						callClassification:
							meeting.callClassification ?? null,
					}
				: null,
			assignedCloser: assignedCloser
				? {
						id: assignedCloser._id,
						email: assignedCloser.email,
						fullName: assignedCloser.fullName ?? null,
						role: assignedCloser.role,
						calendlyUserUri:
							assignedCloser.calendlyUserUri ?? null,
					}
				: null,
		};
	},
});

/**
 * Pull a focused snapshot of an opportunity by id. Useful for asserting
 * post-action state without scraping `npx convex data`.
 */
export const getOpportunitySnapshot = internalQuery({
	args: { opportunityId: v.id("opportunities") },
	handler: async (ctx, { opportunityId }) => {
		const opportunity = await ctx.db.get(opportunityId);
		if (!opportunity) return null;

		const meetings = await ctx.db
			.query("meetings")
			.withIndex("by_opportunityId", (q) =>
				q.eq("opportunityId", opportunity._id),
			)
			.take(20);

		const followUps = await ctx.db
			.query("followUps")
			.withIndex("by_opportunityId", (q) =>
				q.eq("opportunityId", opportunity._id),
			)
			.take(20);

		const payments = await ctx.db
			.query("paymentRecords")
			.withIndex("by_opportunityId", (q) =>
				q.eq("opportunityId", opportunity._id),
			)
			.take(20);

		return {
			opportunity: {
				id: opportunity._id,
				status: opportunity.status,
				source: opportunity.source ?? null,
				assignedCloserId: opportunity.assignedCloserId ?? null,
				lostReason: opportunity.lostReason ?? null,
				lostAt: opportunity.lostAt ?? null,
				canceledAt: opportunity.canceledAt ?? null,
				noShowAt: opportunity.noShowAt ?? null,
				paymentReceivedAt: opportunity.paymentReceivedAt ?? null,
				latestMeetingId: opportunity.latestMeetingId ?? null,
				latestMeetingAt: opportunity.latestMeetingAt ?? null,
				nextMeetingId: opportunity.nextMeetingId ?? null,
				nextMeetingAt: opportunity.nextMeetingAt ?? null,
				utmParams: opportunity.utmParams ?? null,
			},
			meetings: meetings
				.slice()
				.sort((a, b) => b.scheduledAt - a.scheduledAt)
				.map((meeting) => ({
					id: meeting._id,
					status: meeting.status,
					scheduledAt: meeting.scheduledAt,
					assignedCloserId: meeting.assignedCloserId,
					startedAt: meeting.startedAt ?? null,
					stoppedAt: meeting.stoppedAt ?? null,
					noShowMarkedAt: meeting.noShowMarkedAt ?? null,
					completedAt: meeting.completedAt ?? null,
					canceledAt: meeting.canceledAt ?? null,
					rescheduledFromMeetingId:
						meeting.rescheduledFromMeetingId ?? null,
				})),
			followUps: followUps
				.slice()
				.sort((a, b) => b.createdAt - a.createdAt)
				.map((followUp) => ({
					id: followUp._id,
					type: followUp.type,
					status: followUp.status,
					reason: followUp.reason,
					contactMethod: followUp.contactMethod ?? null,
					reminderScheduledAt:
						followUp.reminderScheduledAt ?? null,
					completedAt: followUp.completedAt ?? null,
					completionOutcome: followUp.completionOutcome ?? null,
					createdAt: followUp.createdAt,
				})),
			payments: payments
				.slice()
				.sort((a, b) => b.recordedAt - a.recordedAt)
				.map((payment) => ({
					id: payment._id,
					amountMinor: payment.amountMinor,
					currency: payment.currency,
					status: payment.status,
					paymentType: payment.paymentType,
					commissionable: payment.commissionable,
					attributedCloserId: payment.attributedCloserId ?? null,
					recordedAt: payment.recordedAt,
				})),
		};
	},
});

/**
 * Fetch a focused snapshot of a single meeting by id, plus its parent
 * opportunity status. Useful when a test only cares about one meeting.
 */
export const getMeetingSnapshot = internalQuery({
	args: { meetingId: v.id("meetings") },
	handler: async (ctx, { meetingId }) => {
		const meeting = await ctx.db.get(meetingId);
		if (!meeting) return null;

		const opportunity = await ctx.db.get(meeting.opportunityId);

		return {
			meeting: {
				id: meeting._id,
				status: meeting.status,
				scheduledAt: meeting.scheduledAt,
				durationMinutes: meeting.durationMinutes,
				assignedCloserId: meeting.assignedCloserId,
				calendlyEventUri: meeting.calendlyEventUri,
				calendlyInviteeUri: meeting.calendlyInviteeUri,
				startedAt: meeting.startedAt ?? null,
				stoppedAt: meeting.stoppedAt ?? null,
				noShowMarkedAt: meeting.noShowMarkedAt ?? null,
				completedAt: meeting.completedAt ?? null,
				canceledAt: meeting.canceledAt ?? null,
				utmParams: meeting.utmParams ?? null,
				callClassification: meeting.callClassification ?? null,
				rescheduledFromMeetingId:
					meeting.rescheduledFromMeetingId ?? null,
			},
			opportunity: opportunity
				? {
						id: opportunity._id,
						status: opportunity.status,
						assignedCloserId:
							opportunity.assignedCloserId ?? null,
					}
				: null,
		};
	},
});
