import { type NextRequest, NextResponse, after } from "next/server";
import { unstable_rethrow } from "next/navigation";
import {
	CallbackError,
	getWorkOS,
	handleAuth,
	saveSession,
} from "@workos-inc/authkit-nextjs";
import { reportServerError } from "@/lib/observability/report-server-error";
import { getPostHogClient } from "@/lib/posthog-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOnboardingOrgId(state: string | undefined) {
	if (!state) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(state) as { onboardingOrgId?: unknown };
		return typeof parsed.onboardingOrgId === "string"
			? parsed.onboardingOrgId
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Detect whether this callback originated from a WorkOS invitation email
 * rather than from our app's normal sign-in / sign-up flow.
 *
 * Normal flow: getSignInUrl/getSignUpUrl stores a per-flow PKCE cookie
 * (`wos-auth-verifier-<hash>`) and appends a `state` param. Both are
 * expected on the callback.
 *
 * Invitation flow: The user clicks an email link that goes directly to
 * WorkOS AuthKit, so there is no app-generated `state` param to validate
 * against. A stale PKCE cookie can still exist in the browser from a prior
 * auth attempt, so absence of the cookie is not reliable here.
 */
function isInvitationCallback(request: NextRequest): boolean {
	const hasCode = request.nextUrl.searchParams.has("code");
	const hasState = request.nextUrl.searchParams.has("state");

	// Invitation callbacks arrive with a code but without app-managed state.
	return hasCode && !hasState;
}

/**
 * AuthKit names each PKCE verifier cookie `wos-auth-verifier-<hash>`, one per
 * sign-in flow, so match on the prefix.
 */
const PKCE_COOKIE_PREFIX = "wos-auth-verifier";

function getPkceCookieNames(request: NextRequest): string[] {
	return request.cookies
		.getAll()
		.map((cookie) => cookie.name)
		.filter((name) => name.startsWith(PKCE_COOKIE_PREFIX));
}

/**
 * Get the redirect URI for this environment.
 */
function getRedirectUri(): string {
	return (
		process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
		"http://localhost:3000/callback"
	);
}

/**
 * Best-effort server-side PostHog identify.
 *
 * Supplements the authoritative client-side identify in WorkspaceShell.
 * Creates the person profile early so that even if the JS identify is
 * delayed or fails, PostHog has the user on record.
 *
 * Uses the raw WorkOS `user.id` (e.g. `user_01J...`) which matches the
 * distinct_id extracted by `usePostHogIdentify` on the client.
 */
function identifyUserInPostHog(user: {
	id: string;
	email: string;
	firstName?: string | null;
	lastName?: string | null;
}) {
	try {
		const fullName = [user.firstName, user.lastName]
			.filter(
				(part): part is string =>
					typeof part === "string" && part.trim().length > 0,
			)
			.join(" ")
			.trim();

		const posthog = getPostHogClient();
		if (!posthog) {
			return;
		}

		const properties = {
			email: user.email,
			...(fullName ? { name: fullName } : {}),
			workos_user_id: user.id,
		};
		// Sent after the redirect goes out; a plain `identify()` is queued and
		// can be lost when the serverless function freezes.
		after(() =>
			posthog
				.identifyImmediate({ distinctId: user.id, properties })
				.catch((error: unknown) => {
					console.warn("[PostHog] server-side identify failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}),
		);
	} catch (error) {
		// Best-effort — never block the auth callback for analytics
		console.warn("[PostHog] server-side identify failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// ---------------------------------------------------------------------------
// Invitation callback handler
//
// When a user accepts a WorkOS invitation email, the callback arrives
// with only `code` and no app-managed `state` param. A stale PKCE cookie
// can still exist in the browser, so handleAuth() would misclassify this
// request and fail before a session is established.
//
// Instead we exchange the code directly using the confidential-client
// flow (API key authenticates the exchange instead of PKCE), save the
// session, and redirect to /workspace where claimInvitedAccount will
// link the CRM record.
// ---------------------------------------------------------------------------

/**
 * Low-cardinality description of an auth failure for the fingerprint:
 * AuthKit's `CallbackError` code, the WorkOS API error code, or the HTTP
 * status. Never the message.
 */
function describeAuthError(error: unknown): {
	code: string;
	httpStatus?: number;
} {
	if (error instanceof CallbackError) return { code: error.code };
	const fields = (typeof error === "object" && error !== null ? error : {}) as {
		code?: unknown;
		error?: unknown;
		status?: unknown;
	};
	const httpStatus =
		typeof fields.status === "number" ? fields.status : undefined;
	const apiCode = [fields.code, fields.error].find(
		(value): value is string =>
			typeof value === "string" && /^[a-z0-9_]+$/i.test(value),
	);
	if (apiCode) return { code: apiCode, httpStatus };
	if (httpStatus !== undefined) return { code: `http_${httpStatus}`, httpStatus };
	return { code: error instanceof Error ? error.name : "unknown" };
}

/**
 * Callback failures the user causes (an expired or replayed link, a sign-in
 * started in another browser) rather than a WorkOS or app fault.
 */
const EXPECTED_CALLBACK_ERRORS = new Set([
	"missing_pkce_cookie",
	"oauth_state_mismatch",
	"missing_auth_params",
]);

async function handleInvitationCallback(
	request: NextRequest,
): Promise<NextResponse> {
	const code = request.nextUrl.searchParams.get("code")!;
	const workos = getWorkOS();
	const pkceCookieNames = getPkceCookieNames(request);
	const hadPkceCookie = pkceCookieNames.length > 0;

	// Exchange the authorization code. No codeVerifier needed — the server
	// API key acts as the client secret (confidential client flow).
	const authResponse = await workos.userManagement.authenticateWithCode({
		clientId: process.env.WORKOS_CLIENT_ID!,
		code,
	});

	// The user accepted an org invitation, so organizationId should be set.
	// If not, we still save the session and let the workspace handle it.
	let finalSession = authResponse;
	let orgRefresh: "skipped" | "ok" | "failed" = "skipped";

	if (authResponse.organizationId && authResponse.refreshToken) {
		// Refresh the session scoped to the organization so the JWT includes
		// org claims (organization_id, role, permissions). The initial auth
		// response may not include them if the invitation acceptance happened
		// in the same step.
		try {
			const refreshed =
				await workos.userManagement.authenticateWithRefreshToken({
					clientId: process.env.WORKOS_CLIENT_ID!,
					refreshToken: authResponse.refreshToken,
					organizationId: authResponse.organizationId,
				});

			finalSession = {
				...refreshed,
				organizationId: authResponse.organizationId,
			};
			orgRefresh = "ok";
		} catch (error) {
			// Fall back to the initial session; the workspace can still load.
			orgRefresh = "failed";
			const { code: errorCode, httpStatus } = describeAuthError(error);
			await reportServerError(error, {
				event: "auth.invite_callback.org_refresh_failed",
				request,
				distinctId: authResponse.user.id,
				integration: "workos",
				severity: "warning",
				fingerprint: `auth-invite-org-refresh:${errorCode}`,
				error_code: errorCode,
				http_status: httpStatus,
			});
		}
	}

	// Save the session cookie
	await saveSession(
		{
			accessToken: finalSession.accessToken,
			refreshToken: finalSession.refreshToken,
			user: finalSession.user,
			impersonator: finalSession.impersonator,
		},
		getRedirectUri(),
	);

	console.log("[auth.invite_callback] session saved", {
		userId: finalSession.user.id,
		organizationId: authResponse.organizationId ?? null,
		hadPkceCookie,
		orgRefresh,
	});

	// Best-effort server-side PostHog identify (supplementary to client-side)
	identifyUserInPostHog(finalSession.user);

	// Redirect to workspace — claimInvitedAccount will link the CRM record
	const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
	const response = NextResponse.redirect(new URL("/workspace", appUrl));

	// Clean up any stale PKCE verifiers so they cannot interfere with later auth flows.
	for (const name of pkceCookieNames) {
		response.cookies.delete(name);
	}

	return response;
}

// ---------------------------------------------------------------------------
// Main callback handler
// ---------------------------------------------------------------------------

const standardAuthHandler = handleAuth({
	onSuccess: async ({ refreshToken, user, organizationId, state }) => {
		const onboardingOrgId = getOnboardingOrgId(state);

		// Best-effort server-side PostHog identify (supplementary to client-side)
		identifyUserInPostHog(user);

		if (!organizationId && onboardingOrgId) {
			const workos = getWorkOS();
			const memberships =
				await workos.userManagement.listOrganizationMemberships({
					organizationId: onboardingOrgId,
					userId: user.id,
				});

			let membership: "existing" | "created" | "create_failed" =
				memberships.data.length > 0 ? "existing" : "created";
			if (membership === "created") {
				try {
					await workos.userManagement.createOrganizationMembership({
						organizationId: onboardingOrgId,
						userId: user.id,
					});
				} catch (error) {
					// Don't fail the auth callback; the user can retry login
					membership = "create_failed";
					console.error("[callback] Failed to create org membership:", error);
					const { code: errorCode, httpStatus } = describeAuthError(error);
					await reportServerError(error, {
						event: "auth.membership_create.failed",
						distinctId: user.id,
						integration: "workos",
						fingerprint: `auth-membership-create:${errorCode}`,
						error_code: errorCode,
						http_status: httpStatus,
						workos_org_id: onboardingOrgId,
					});
				}
			}

			const refreshedSession =
				await workos.userManagement.authenticateWithRefreshToken({
					clientId: process.env.WORKOS_CLIENT_ID!,
					refreshToken,
					organizationId: onboardingOrgId,
				});

			await saveSession(
				{
					accessToken: refreshedSession.accessToken,
					refreshToken: refreshedSession.refreshToken,
					user: refreshedSession.user,
					impersonator: refreshedSession.impersonator,
				},
				getRedirectUri(),
			);

			console.log("[auth.callback] session saved", {
				userId: refreshedSession.user.id,
				organizationId: onboardingOrgId,
				flow: "onboarding_org",
				membership,
			});
			return;
		}

		console.log("[auth.callback] session saved", {
			userId: user.id,
			organizationId: organizationId ?? null,
			flow: "standard",
		});
	},
	onError: async ({ error, request }) => {
		// Next redirects thrown from `onSuccess` are control flow, not failures.
		unstable_rethrow(error);

		const { code, httpStatus } = describeAuthError(error);
		const expected = EXPECTED_CALLBACK_ERRORS.has(code);
		await reportServerError(error, {
			event: "auth.callback.failed",
			request,
			integration: "workos",
			expected,
			fingerprint: `auth-callback:${code}`,
			error_code: code,
			http_status: httpStatus,
		});

		// Same response AuthKit returns when no `onError` is configured.
		return NextResponse.json(
			{
				error: {
					message: "Something went wrong",
					description:
						"Couldn't sign in. If you are not sure what happened, please contact your organization admin.",
				},
			},
			{ status: 500 },
		);
	},
});

export async function GET(request: NextRequest) {
	// Invitation callbacks bypass handleAuth because they lack app-managed
	// state, even if a stale PKCE cookie is still present in the browser.
	if (isInvitationCallback(request)) {
		try {
			return await handleInvitationCallback(request);
		} catch (error) {
			const { code, httpStatus } = describeAuthError(error);
			console.error("[auth.invite_callback] failed", {
				errorCode: code,
				httpStatus: httpStatus ?? null,
			});
			await reportServerError(error, {
				event: "auth.invite_callback.failed",
				request,
				integration: "workos",
				fingerprint: `auth-invite-callback:${code}`,
				error_code: code,
				http_status: httpStatus,
			});
			// Fall through to standard handler as last resort
		}
	}

	// Standard PKCE-based callback (sign-in, sign-up, tenant onboarding)
	return standardAuthHandler(request);
}
