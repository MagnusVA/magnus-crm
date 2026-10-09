"use node";

import { WorkOS } from "@workos-inc/node";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { action, type ActionCtx, env } from "../_generated/server";
import { getIdentityOrgId } from "../lib/identity";
import { rejectRequest } from "../lib/observability/errors";
import {
	log,
	logRequestContext,
	reportError,
} from "../lib/observability/log";
import { ADMIN_ROLES, mapCrmRoleToWorkosSlug } from "../lib/roleMapping";
import { validateEmail, validateRequiredString } from "../lib/validation";
import {
	getCanonicalIdentityWorkosUserId,
	getRawWorkosUserId,
} from "../lib/workosUserId";

const workos = new WorkOS(env.WORKOS_API_KEY, {
	clientId: env.WORKOS_CLIENT_ID,
});

type TenantSummary = {
	_id: Id<"tenants">;
	workosOrgId: string;
	status: Doc<"tenants">["status"];
	companyName: string;
	calendlyWebhookUri?: string;
	tenantOwnerId: Doc<"tenants">["tenantOwnerId"];
};

type AdminContext = {
	caller: Doc<"users">;
	tenant: TenantSummary;
	callerWorkosUserId: string;
};

const crmRoleValidator = v.union(
	v.literal("tenant_master"),
	v.literal("tenant_admin"),
	v.literal("closer"),
	v.literal("lead_generator"),
);

async function requireAdminContext(ctx: ActionCtx): Promise<AdminContext> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw rejectRequest("auth.not_authenticated", "Not authenticated");
	}

	const callerWorkosUserId = getCanonicalIdentityWorkosUserId(identity);
	if (!callerWorkosUserId) {
		throw rejectRequest(
			"auth.missing_workos_user_id",
			"Missing WorkOS user ID",
		);
	}

	const caller: Doc<"users"> | null = await ctx.runQuery(
		internal.users.queries.getCurrentUserInternal,
		{ workosUserId: callerWorkosUserId },
	);
	const identityOrgId = getIdentityOrgId(identity);
	if (caller) {
		logRequestContext({
			distinctId: getRawWorkosUserId(callerWorkosUserId),
			userId: caller._id,
			tenantId: caller.tenantId,
			workosOrgId: identityOrgId,
			role: caller.role,
		});
	}
	if (!caller || !ADMIN_ROLES.includes(caller.role)) {
		throw rejectRequest(
			"auth.insufficient_permissions",
			"Insufficient permissions",
			{ role: caller?.role, hasCrmUser: Boolean(caller) },
		);
	}

	const tenant: TenantSummary | null = await ctx.runQuery(
		internal.tenants.getCalendlyTenant,
		{
			tenantId: caller.tenantId,
		},
	);
	if (!tenant) {
		throw new Error("Tenant not found");
	}

	if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
		throw rejectRequest("auth.organization_mismatch", "Not authorized", {
			tenantId: tenant._id,
			hasOrgId: Boolean(identityOrgId),
		});
	}

	return { caller, tenant, callerWorkosUserId };
}

function workosErrorStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
}

/**
 * A failed invitation revoke never blocks the caller. 404 and 400 mean the
 * invitation is already revoked, accepted, or expired; anything else goes to
 * Error Tracking.
 */
function handleInvitationRevokeFailure(
	error: unknown,
	attrs: {
		operation: "update_user_role" | "remove_user";
		tenantId: Id<"tenants">;
		userId: Id<"users">;
		invitationId: string;
	},
) {
	const httpStatus = workosErrorStatus(error);
	if (httpStatus === 404 || httpStatus === 400) {
		log.info("workos.invitation.revoke_skipped", {
			...attrs,
			reason: "already_inactive",
			httpStatus,
		});
		return;
	}
	const code =
		typeof error === "object" && error !== null
			? (error as { code?: unknown }).code
			: undefined;
	reportError(
		"workos.invitation.revoke_failed",
		new Error(
			httpStatus === undefined
				? "WorkOS revokeInvitation failed"
				: `WorkOS revokeInvitation failed: HTTP ${httpStatus}${
						typeof code === "string" ? ` (${code})` : ""
					}`,
		),
		{
			severity: "warning",
			integration: "workos",
			fingerprint: `workos.invitation.revoke_failed:${httpStatus ?? "network"}`,
			httpStatus,
			...attrs,
		},
	);
}

async function getMembership(workosUserId: string, organizationId: string) {
	const memberships = await workos.userManagement.listOrganizationMemberships(
		{
			userId: getRawWorkosUserId(workosUserId),
			organizationId,
		},
	);

	return memberships.data[0] ?? null;
}

async function getWorkosUserByEmail(email: string) {
	const users = await workos.userManagement.listUsers({
		email,
		limit: 1,
	});

	return users.data.find((user) => user.email === email) ?? null;
}

async function getPendingInvitation(email: string, organizationId: string) {
	const invitations = await workos.userManagement.listInvitations({
		email,
		organizationId,
		limit: 10,
	});

	return (
		invitations.data.find((invitation) => invitation.state === "pending") ??
		null
	);
}

async function getTenantUserOrThrow(
	ctx: ActionCtx,
	tenantId: Id<"tenants">,
	userId: Id<"users">,
) {
	const user = await ctx.runQuery(internal.users.queries.getById, { userId });
	if (!user || user.tenantId !== tenantId) {
		throw new Error("User not found");
	}

	return user;
}

async function getValidatedCalendlyMember(
	ctx: ActionCtx,
	tenantId: Id<"tenants">,
	calendlyMemberId: Id<"calendlyOrgMembers">,
): Promise<Doc<"calendlyOrgMembers">> {
	const member: Doc<"calendlyOrgMembers"> | null = await ctx.runQuery(
		internal.calendly.orgMembersQueries.getMember,
		{ memberId: calendlyMemberId },
	);

	if (!member || member.tenantId !== tenantId) {
		throw new Error("Invalid Calendly member");
	}

	return member;
}

function normalizeInviteInput(
	email: string,
	firstName: string,
	lastName?: string,
) {
	const emailValidation = validateEmail(email);
	if (!emailValidation.valid) {
		throw new Error(emailValidation.error);
	}

	const firstNameValidation = validateRequiredString(firstName, {
		fieldName: "First name",
	});
	if (!firstNameValidation.valid) {
		throw new Error(firstNameValidation.error);
	}

	const normalizedEmail = email.trim().toLowerCase();
	const normalizedFirstName = firstName.trim();
	const normalizedLastName = lastName?.trim() || undefined;
	const fullName = [normalizedFirstName, normalizedLastName]
		.filter(Boolean)
		.join(" ");

	return {
		normalizedEmail,
		normalizedFirstName,
		normalizedLastName,
		fullName: fullName || undefined,
	};
}

/**
 * Invite a new user to the tenant organization.
 *
 * This single action handles the ENTIRE flow:
 * 1. Validate caller authorization (must be tenant_master or tenant_admin)
 * 2. Validate Calendly member selection (if provided)
 * 3. Send WorkOS invitation email (handles sign-up for new users)
 * 4. Create fully-provisioned CRM user record with placeholder workosUserId
 * 5. Link Calendly org member (if applicable)
 *
 * IMPORTANT: We do NOT call workos.userManagement.createUser() here.
 * Creating a shell WorkOS user before the invitation would block sign-up —
 * WorkOS would see an existing user with no credentials and show a login
 * form instead of sign-up. By letting sendInvitation() handle it, new users
 * are presented with a proper sign-up flow when they click the email link.
 *
 * After sign-up, the user's real workosUserId is linked to this CRM record
 * via the claimInvitedAccount mutation (called automatically on first load).
 */
export const inviteUser = action({
	args: {
		email: v.string(),
		firstName: v.string(),
		lastName: v.optional(v.string()),
		role: crmRoleValidator,
		calendlyMemberId: v.optional(v.id("calendlyOrgMembers")),
	},
	handler: async (
		ctx,
		{ email, firstName, lastName, role, calendlyMemberId },
	): Promise<{
		userId: Id<"users">;
		invitationId?: string;
	}> => {
		const { caller, tenant, callerWorkosUserId } =
			await requireAdminContext(ctx);
		const { normalizedEmail, fullName } = normalizeInviteInput(
			email,
			firstName,
			lastName,
		);

		if (role === "tenant_master") {
			throw new Error(
				"The owner role is assigned during onboarding and cannot be granted to other users",
			);
		}

		const existingTenantUser: Doc<"users"> | null = await ctx.runQuery(
			internal.users.queries.getByTenantAndEmail,
			{
				tenantId: caller.tenantId,
				email: normalizedEmail,
			},
		);
		if (existingTenantUser) {
			throw new Error("A team member with this email already exists");
		}

		let calendlyUserUri: string | undefined;
		if (calendlyMemberId) {
			if (role !== "closer") {
				throw new Error(
					"Only closers can be linked to Calendly members",
				);
			}

			const member: Doc<"calendlyOrgMembers"> =
				await getValidatedCalendlyMember(
					ctx,
					caller.tenantId,
					calendlyMemberId,
				);
			if (member.matchedUserId) {
				throw new Error(
					"This Calendly member is already linked to another user",
				);
			}

			calendlyUserUri = member.calendlyUserUri;
		}

		// -----------------------------------------------------------------------
		// Send the WorkOS invitation email.
		//
		// We intentionally do NOT call workos.userManagement.createUser() first.
		// sendInvitation() handles both cases:
		//   - New user (no WorkOS account): shows sign-up form → creates account
		//   - Existing user (has WorkOS account): shows sign-in form → joins org
		//
		// The invitation automatically creates the org membership with the
		// correct roleSlug when accepted.
		// -----------------------------------------------------------------------
		const desiredRoleSlug = mapCrmRoleToWorkosSlug(role);
		let invitationId: string | undefined;
		let membershipRoleUpdated = false;

		// Check if user already has a WorkOS account AND an existing membership
		// (edge case: re-inviting someone who previously had access).
		const existingWorkosUser = await getWorkosUserByEmail(normalizedEmail);

		if (existingWorkosUser) {
			const existingMembership = await getMembership(
				existingWorkosUser.id,
				tenant.workosOrgId,
			);

			if (existingMembership) {
				// User already has membership — just update the role if needed
				if (existingMembership.role.slug !== desiredRoleSlug) {
					await workos.userManagement.updateOrganizationMembership(
						existingMembership.id,
						{ roleSlug: desiredRoleSlug },
					);
					membershipRoleUpdated = true;
				}
			} else {
				// User exists in WorkOS but not in this org — send invitation
				invitationId = await sendOrResendInvitation(
					normalizedEmail,
					tenant.workosOrgId,
					callerWorkosUserId,
					desiredRoleSlug,
				);
			}
		} else {
			// No WorkOS user at all — send invitation (sign-up flow)
			invitationId = await sendOrResendInvitation(
				normalizedEmail,
				tenant.workosOrgId,
				callerWorkosUserId,
				desiredRoleSlug,
			);
		}

		// -----------------------------------------------------------------------
		// Create the CRM user record with a placeholder workosUserId.
		//
		// The placeholder format "pending:<email>" ensures:
		//   - The record won't collide with real WorkOS user IDs
		//   - We can identify pending records for the claim flow
		//   - The Calendly org member link is established immediately
		//
		// After sign-up, claimInvitedAccount patches in the real workosUserId.
		// -----------------------------------------------------------------------
		const placeholderWorkosUserId = `pending:${normalizedEmail}`;

		const userId: Id<"users"> = await ctx.runMutation(
			internal.workos.userMutations.createInvitedUser,
			{
				tenantId: caller.tenantId,
				workosUserId: placeholderWorkosUserId,
				email: normalizedEmail,
				fullName,
				role,
				calendlyUserUri,
				calendlyMemberId,
				invitationStatus: "pending",
				workosInvitationId: invitationId,
			},
		);
		log.info("workos.user.invited", {
			tenantId: caller.tenantId,
			userId,
			role,
			outcome: invitationId ? "invitation_sent" : "existing_membership_reused",
			membershipRoleUpdated,
			hadWorkosAccount: Boolean(existingWorkosUser),
			calendlyMemberId,
		});

		return {
			userId,
			invitationId,
		};
	},
});

/**
 * Send a new WorkOS invitation or resend an existing pending one.
 * Returns the invitation ID.
 */
async function sendOrResendInvitation(
	email: string,
	organizationId: string,
	inviterWorkosUserId: string,
	roleSlug: string,
): Promise<string> {
	const pendingInvitation = await getPendingInvitation(email, organizationId);

	if (pendingInvitation) {
		const resentInvitation = await workos.userManagement.resendInvitation(
			pendingInvitation.id,
		);
		log.info("workos.invitation.sent", {
			workosOrgId: organizationId,
			invitationId: resentInvitation.id,
			resent: true,
		});
		return resentInvitation.id;
	}

	const invitation = await workos.userManagement.sendInvitation({
		email,
		organizationId,
		inviterUserId: getRawWorkosUserId(inviterWorkosUserId),
		roleSlug,
	});
	log.info("workos.invitation.sent", {
		workosOrgId: organizationId,
		invitationId: invitation.id,
		resent: false,
	});
	return invitation.id;
}

/**
 * Update a user's role in both WorkOS and the CRM.
 *
 * Steps:
 * 1. Validate caller is admin/owner
 * 2. Find the user's WorkOS membership (skip for pending invitation users)
 * 3. Update the membership role slug
 * 4. Update the CRM user role
 *
 * Note: Role changes take effect on the user's NEXT session.
 * For pending invitation users, only the CRM role is updated — the WorkOS
 * membership role was already set via sendInvitation() and will be correct
 * when they sign up. If the invitation is still pending in WorkOS, we
 * revoke and re-send with the new role.
 */
export const updateUserRole = action({
	args: {
		userId: v.id("users"),
		newRole: crmRoleValidator,
	},
	handler: async (ctx, { userId, newRole }) => {
		const { caller, tenant, callerWorkosUserId } =
			await requireAdminContext(ctx);
		const user = await getTenantUserOrThrow(ctx, caller.tenantId, userId);

		if (newRole === "tenant_master") {
			throw new Error(
				"The owner role is assigned during onboarding and cannot be granted to other users",
			);
		}

		if (tenant.tenantOwnerId === user._id) {
			throw new Error("The owner's role cannot be changed");
		}

		const isPending = user.invitationStatus === "pending";

		if (isPending) {
			// User hasn't signed up yet — no WorkOS membership to update.
			// If there's a pending WorkOS invitation, revoke it and re-send
			// with the new role so the membership gets the right role on accept.
			if (user.workosInvitationId) {
				try {
					await workos.userManagement.revokeInvitation(
						user.workosInvitationId,
					);
				} catch (error) {
					// Invitation may already be expired/revoked — proceed regardless
					handleInvitationRevokeFailure(error, {
						operation: "update_user_role",
						tenantId: caller.tenantId,
						userId,
						invitationId: user.workosInvitationId,
					});
				}

				const newInvitationId = await sendOrResendInvitation(
					user.email,
					tenant.workosOrgId,
					callerWorkosUserId,
					mapCrmRoleToWorkosSlug(newRole),
				);

				await ctx.runMutation(
					internal.workos.userMutations.updateRoleAndInvitation,
					{
						userId,
						role: newRole,
						workosInvitationId: newInvitationId,
					},
				);
			} else {
				await ctx.runMutation(
					internal.workos.userMutations.updateRole,
					{
						userId,
						role: newRole,
					},
				);
			}

			log.info("workos.user.role_updated", {
				tenantId: caller.tenantId,
				userId,
				fromRole: user.role,
				toRole: newRole,
				pendingInvitation: true,
				invitationReissued: Boolean(user.workosInvitationId),
			});
			return { userId, role: newRole };
		}

		// Active user — update WorkOS membership directly
		const membership = await getMembership(
			user.workosUserId,
			tenant.workosOrgId,
		);
		if (!membership) {
			log.warn("workos.user.rejected", {
				reason: "membership_not_found",
				operation: "update_user_role",
				tenantId: caller.tenantId,
				userId,
			});
			throw new Error("No WorkOS membership found for this user");
		}

		await workos.userManagement.updateOrganizationMembership(
			membership.id,
			{
				roleSlug: mapCrmRoleToWorkosSlug(newRole),
			},
		);
		log.info("workos.user.role_updated", {
			tenantId: caller.tenantId,
			userId,
			fromRole: user.role,
			toRole: newRole,
			pendingInvitation: false,
			membershipId: membership.id,
		});

		await ctx.runMutation(internal.workos.userMutations.updateRole, {
			userId,
			role: newRole,
		});

		return { userId, role: newRole };
	},
});

/**
 * Remove a user from the tenant organization.
 *
 * Steps:
 * 1. Validate caller is admin/owner
 * 2. Prevent self-removal
 * 3. For pending invitation users: revoke WorkOS invitation
 * 4. For active users: remove WorkOS org membership
 * 5. Delete CRM user record + unlink Calendly member
 */
export const removeUser = action({
	args: { userId: v.id("users") },
	handler: async (ctx, { userId }) => {
		const { caller, tenant } = await requireAdminContext(ctx);
		const user = await getTenantUserOrThrow(ctx, caller.tenantId, userId);

		if (user._id === caller._id) {
			throw new Error("Cannot remove yourself");
		}

		if (tenant.tenantOwnerId === user._id) {
			throw new Error("Cannot remove the tenant owner");
		}

		const activeAssignedOpportunityCount: number = await ctx.runQuery(
			internal.users.queries.getActiveAssignedOpportunityCount,
			{
				tenantId: caller.tenantId,
				userId,
			},
		);
		if (activeAssignedOpportunityCount > 0) {
			throw new ConvexError(
				"Cannot remove a user who still has active assigned opportunities",
			);
		}

		const isPending = user.invitationStatus === "pending";
		let membershipDeleted = false;

		if (isPending) {
			// User hasn't signed up yet — revoke the WorkOS invitation instead
			// of trying to remove a membership that doesn't exist.
			if (user.workosInvitationId) {
				try {
					await workos.userManagement.revokeInvitation(
						user.workosInvitationId,
					);
				} catch (error) {
					// Invitation may already be expired/revoked — proceed with removal
					handleInvitationRevokeFailure(error, {
						operation: "remove_user",
						tenantId: caller.tenantId,
						userId,
						invitationId: user.workosInvitationId,
					});
				}
			}
		} else {
			// Active user — remove WorkOS org membership
			const membership = await getMembership(
				user.workosUserId,
				tenant.workosOrgId,
			);
			if (membership) {
				await workos.userManagement.deleteOrganizationMembership(
					membership.id,
				);
				membershipDeleted = true;
			}
		}

		await ctx.runMutation(internal.workos.userMutations.removeUser, {
			userId,
		});
		log.info("workos.user.removed", {
			tenantId: caller.tenantId,
			userId,
			wasPending: isPending,
			membershipDeleted,
		});

		return { userId };
	},
});
