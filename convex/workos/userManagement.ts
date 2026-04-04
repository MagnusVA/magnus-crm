"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { action, type ActionCtx } from "../_generated/server";
import { getIdentityOrgId } from "../lib/identity";
import { ADMIN_ROLES, mapCrmRoleToWorkosSlug } from "../lib/roleMapping";
import { validateEmail, validateRequiredString } from "../lib/validation";
import {
	getCanonicalIdentityWorkosUserId,
	getRawWorkosUserId,
} from "../lib/workosUserId";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
	clientId: process.env.WORKOS_CLIENT_ID!,
});

type TenantSummary = {
	_id: Id<"tenants">;
	workosOrgId: string;
	status: Doc<"tenants">["status"];
	companyName: string;
	calendlyWebhookUri: Doc<"tenants">["calendlyWebhookUri"];
	tenantOwnerId: Doc<"tenants">["tenantOwnerId"];
};

type AdminContext = {
	caller: Doc<"users">;
	tenant: TenantSummary;
	callerWorkosUserId: string;
};

async function requireAdminContext(ctx: ActionCtx): Promise<AdminContext> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error("Not authenticated");
	}

	const callerWorkosUserId = getCanonicalIdentityWorkosUserId(identity);
	if (!callerWorkosUserId) {
		throw new Error("Missing WorkOS user ID");
	}

	const caller: Doc<"users"> | null = await ctx.runQuery(
		internal.users.queries.getCurrentUserInternal,
		{ workosUserId: callerWorkosUserId },
	);
	if (!caller || !ADMIN_ROLES.includes(caller.role)) {
		throw new Error("Insufficient permissions");
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

	const identityOrgId = getIdentityOrgId(identity);
	if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
		throw new Error("Not authorized");
	}

	return { caller, tenant, callerWorkosUserId };
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
		role: v.union(
			v.literal("tenant_master"),
			v.literal("tenant_admin"),
			v.literal("closer"),
		),
		calendlyMemberId: v.optional(v.id("calendlyOrgMembers")),
	},
	handler: async (
		ctx,
		{ email, firstName, lastName, role, calendlyMemberId },
	): Promise<{
		userId: Id<"users">;
		invitationId?: string;
	}> => {
		console.log("[WorkOS:Users] inviteUser called", {
			role,
			hasCalendlyMember: !!calendlyMemberId,
		});
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

		console.log("[WorkOS:Users] inviteUser input validated", {
			role,
			tenantId: caller.tenantId,
		});
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
				}
				console.log(
					"[WorkOS:Users] inviteUser existing membership reused",
					{
						membershipId: existingMembership.id,
					},
				);
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
		console.log("[WorkOS:Users] inviteUser CRM record created", {
			userId,
			invitationId,
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
		console.log("[WorkOS:Users] invitation resent", {
			invitationId: resentInvitation.id,
		});
		return resentInvitation.id;
	}

	const invitation = await workos.userManagement.sendInvitation({
		email,
		organizationId,
		inviterUserId: getRawWorkosUserId(inviterWorkosUserId),
		roleSlug,
	});
	console.log("[WorkOS:Users] invitation sent", {
		invitationId: invitation.id,
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
		newRole: v.union(
			v.literal("tenant_master"),
			v.literal("tenant_admin"),
			v.literal("closer"),
		),
	},
	handler: async (ctx, { userId, newRole }) => {
		console.log("[WorkOS:Users] updateUserRole called", {
			userId,
			newRole,
		});
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
					console.log(
						"[WorkOS:Users] updateUserRole revoked old invitation",
						{
							invitationId: user.workosInvitationId,
						},
					);
				} catch (error) {
					// Invitation may already be expired/revoked — proceed regardless
					console.warn(
						"[WorkOS:Users] updateUserRole revoke failed (proceeding)",
						{
							invitationId: user.workosInvitationId,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
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

			console.log(
				"[WorkOS:Users] updateUserRole completed (pending user)",
				{ userId, newRole },
			);
			return { userId, role: newRole };
		}

		// Active user — update WorkOS membership directly
		const membership = await getMembership(
			user.workosUserId,
			tenant.workosOrgId,
		);
		console.log("[WorkOS:Users] updateUserRole membership lookup", {
			found: !!membership,
			membershipId: membership?.id,
		});
		if (!membership) {
			throw new Error("No WorkOS membership found for this user");
		}

		await workos.userManagement.updateOrganizationMembership(
			membership.id,
			{
				roleSlug: mapCrmRoleToWorkosSlug(newRole),
			},
		);
		console.log("[WorkOS:Users] updateUserRole role changed", {
			userId,
			from: user.role,
			to: newRole,
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
		console.log("[WorkOS:Users] removeUser called", { userId });
		const { caller, tenant } = await requireAdminContext(ctx);
		const user = await getTenantUserOrThrow(ctx, caller.tenantId, userId);

		if (user._id === caller._id) {
			throw new Error("Cannot remove yourself");
		}

		if (tenant.tenantOwnerId === user._id) {
			throw new Error("Cannot remove the tenant owner");
		}

		const isPending = user.invitationStatus === "pending";

		if (isPending) {
			// User hasn't signed up yet — revoke the WorkOS invitation instead
			// of trying to remove a membership that doesn't exist.
			if (user.workosInvitationId) {
				try {
					await workos.userManagement.revokeInvitation(
						user.workosInvitationId,
					);
					console.log(
						"[WorkOS:Users] removeUser WorkOS invitation revoked",
						{
							invitationId: user.workosInvitationId,
						},
					);
				} catch (error) {
					// Invitation may already be expired/revoked — proceed with removal
					console.warn(
						"[WorkOS:Users] removeUser revoke invitation failed (proceeding)",
						{
							invitationId: user.workosInvitationId,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
				}
			}
		} else {
			// Active user — remove WorkOS org membership
			const membership = await getMembership(
				user.workosUserId,
				tenant.workosOrgId,
			);
			console.log("[WorkOS:Users] removeUser membership found", {
				found: !!membership,
				membershipId: membership?.id,
			});
			if (membership) {
				await workos.userManagement.deleteOrganizationMembership(
					membership.id,
				);
				console.log(
					"[WorkOS:Users] removeUser WorkOS membership deleted",
					{ membershipId: membership.id },
				);
			}
		}

		await ctx.runMutation(internal.workos.userMutations.removeUser, {
			userId,
		});
		console.log("[WorkOS:Users] removeUser completed", {
			userId,
			wasPending: isPending,
		});

		return { userId };
	},
});
