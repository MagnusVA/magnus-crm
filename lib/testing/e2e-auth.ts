import "server-only";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Test-only AuthKit session bridge
//
// This module signs and verifies short-lived login tokens that the test-only
// `/api/testing/auth/login` route exchanges for a real WorkOS AuthKit session.
//
// Security model:
//   - Module is server-only.
//   - Token signing requires `E2E_AUTH_ENABLED=1` and a strong secret.
//   - Tokens are HMAC-SHA256 signed and verified with a constant-time compare.
//   - Tokens encode a role *alias* (not a raw email/password) so the public
//     login URL is not a generic password-auth endpoint.
//   - Tokens carry an explicit `orgId` and `returnTo`. The route enforces both.
//
// See `brainstorming/AGENT_E2E_TESTING.md` for the full design and threat model.
// ---------------------------------------------------------------------------

export type E2ERoleAlias = "tenant_owner" | "closer1";

export const E2E_ROLE_ALIASES: readonly E2ERoleAlias[] = [
	"tenant_owner",
	"closer1",
] as const;

export type E2ELoginTokenPayload = {
	typ: "magnus.e2e.login";
	role: E2ERoleAlias;
	orgId: string;
	returnTo: string;
	iat: number;
	exp: number;
	nonce: string;
};

const ROLE_EMAIL_ENV: Record<E2ERoleAlias, string> = {
	tenant_owner: "E2E_TENANT_OWNER_EMAIL",
	closer1: "E2E_CLOSER1_EMAIL",
};

function base64url(input: Buffer | string): string {
	const buffer = typeof input === "string" ? Buffer.from(input) : input;
	return buffer
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function requireE2ESecret(): string {
	const secret = process.env.E2E_AUTH_TOKEN_SECRET;
	if (!secret || secret.length < 32) {
		throw new Error(
			"E2E_AUTH_TOKEN_SECRET is missing or shorter than 32 chars.",
		);
	}
	return secret;
}

/**
 * Throws if E2E auth is not explicitly enabled in this environment.
 * Both the signing CLI and the login route call this before doing anything.
 */
export function requireE2EEnabled(): void {
	if (process.env.E2E_AUTH_ENABLED !== "1") {
		throw new Error("E2E auth is disabled (E2E_AUTH_ENABLED !== '1').");
	}
}

export function isE2EEnabled(): boolean {
	return process.env.E2E_AUTH_ENABLED === "1";
}

/**
 * Resolve the configured email for a role alias.
 * Throws if the env var is not set.
 */
export function getE2EEmailForRole(role: E2ERoleAlias): string {
	const envName = ROLE_EMAIL_ENV[role];
	const email = process.env[envName];
	if (!email || email.trim().length === 0) {
		throw new Error(`Missing ${envName} for role alias ${role}.`);
	}
	return email.trim();
}

/**
 * Sign a short-lived login token. Default TTL is 60 seconds.
 *
 * The token payload is base64url(JSON) followed by `.` and the base64url
 * signature, signed with HMAC-SHA256 over the body.
 */
export function signE2ELoginToken(
	input: Omit<E2ELoginTokenPayload, "typ" | "iat" | "exp" | "nonce">,
	options: { ttlMs?: number } = {},
): string {
	requireE2EEnabled();

	const ttlMs = options.ttlMs ?? 60_000;
	const now = Date.now();

	if (!E2E_ROLE_ALIASES.includes(input.role)) {
		throw new Error(`Unknown E2E role alias: ${String(input.role)}`);
	}

	if (!input.orgId || !input.orgId.startsWith("org_")) {
		throw new Error("E2E orgId must be a WorkOS organization id (org_…).");
	}

	if (!input.returnTo.startsWith("/") || input.returnTo.startsWith("//")) {
		throw new Error("E2E returnTo must be an app-relative path (/...).");
	}

	const payload: E2ELoginTokenPayload = {
		typ: "magnus.e2e.login",
		role: input.role,
		orgId: input.orgId,
		returnTo: input.returnTo,
		iat: now,
		exp: now + ttlMs,
		nonce: crypto.randomUUID(),
	};

	const body = base64url(JSON.stringify(payload));
	const signature = crypto
		.createHmac("sha256", requireE2ESecret())
		.update(body)
		.digest();

	return `${body}.${base64url(signature)}`;
}

/**
 * Verify a signed login token and return its parsed payload.
 *
 * Throws if any of:
 *   - E2E auth is disabled
 *   - the token is malformed or has a bad signature
 *   - the typ/role/returnTo are invalid
 *   - the token is expired
 */
export function verifyE2ELoginToken(token: string): E2ELoginTokenPayload {
	requireE2EEnabled();

	const parts = token.split(".");
	if (parts.length !== 2) {
		throw new Error("Malformed E2E login token.");
	}
	const [body, signature] = parts;
	if (!body || !signature) {
		throw new Error("Malformed E2E login token.");
	}

	const expected = base64url(
		crypto.createHmac("sha256", requireE2ESecret()).update(body).digest(),
	);

	const actualBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expected);
	if (
		actualBuffer.length !== expectedBuffer.length ||
		!crypto.timingSafeEqual(
			new Uint8Array(actualBuffer),
			new Uint8Array(expectedBuffer),
		)
	) {
		throw new Error("Invalid E2E login token signature.");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
	} catch {
		throw new Error("Malformed E2E login token payload.");
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error("Malformed E2E login token payload.");
	}

	const payload = parsed as Partial<E2ELoginTokenPayload>;

	if (payload.typ !== "magnus.e2e.login") {
		throw new Error("Invalid E2E token type.");
	}
	if (
		typeof payload.role !== "string" ||
		!E2E_ROLE_ALIASES.includes(payload.role as E2ERoleAlias)
	) {
		throw new Error("Invalid E2E role alias.");
	}
	if (typeof payload.orgId !== "string" || !payload.orgId.startsWith("org_")) {
		throw new Error("Invalid E2E orgId.");
	}
	if (
		typeof payload.returnTo !== "string" ||
		!payload.returnTo.startsWith("/") ||
		payload.returnTo.startsWith("//")
	) {
		throw new Error("E2E returnTo must be an app-relative path.");
	}
	if (typeof payload.exp !== "number" || Date.now() > payload.exp) {
		throw new Error("Expired E2E login token.");
	}

	return payload as E2ELoginTokenPayload;
}

/**
 * Resolve and validate the configured tenant org id used by the login route.
 * Returns null if it is not configured. The route should treat that as 403.
 */
export function getConfiguredE2EOrgId(): string | null {
	const orgId = process.env.E2E_TEST_TENANT_WORKOS_ORG_ID;
	if (!orgId || !orgId.startsWith("org_")) {
		return null;
	}
	return orgId;
}

/**
 * Parse the comma-separated allowed origins list.
 * Defaults to localhost / 127.0.0.1 on port 3000.
 */
export function getE2EAllowedOrigins(): string[] {
	const raw =
		process.env.E2E_AUTH_ALLOWED_ORIGINS ??
		"http://localhost:3000,http://127.0.0.1:3000";
	return raw
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
}
