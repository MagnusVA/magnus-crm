#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/e2e-login-url.mjs
//
// Print a signed login URL that the test-only `/api/testing/auth/login`
// route can exchange for a real WorkOS AuthKit session.
//
// Usage:
//   node scripts/e2e-login-url.mjs <tenant_owner|closer1> [returnTo]
//
// Examples:
//   node scripts/e2e-login-url.mjs closer1 /workspace/closer
//   node scripts/e2e-login-url.mjs tenant_owner /workspace/pipeline
//   node scripts/e2e-login-url.mjs closer1 /workspace/closer/meetings/<id>
//
// Required env (loaded from `.env.local` automatically when present):
//   E2E_AUTH_ENABLED=1
//   E2E_AUTH_TOKEN_SECRET=<>=32 char secret>
//   E2E_TEST_TENANT_WORKOS_ORG_ID=org_…
//   NEXT_PUBLIC_APP_URL=http://localhost:3000   (optional, this is the default)
//
// The signing logic here MUST stay in sync with `lib/testing/e2e-auth.ts`.
// If you change the payload shape or signing algorithm, update both files.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VALID_ROLES = new Set(["tenant_owner", "closer1"]);
const TOKEN_TTL_MS = 60_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

/**
 * Minimal `.env.local` loader.
 *
 * Skips lines that are blank, comments, or already set in process.env.
 * Strips surrounding single or double quotes from values, like Next.js does.
 * Anything past a closing quote on the same line is ignored, matching how
 * Next.js parses `KEY="value"trailing` (so a malformed entry surfaces only
 * the quoted portion rather than the concatenation).
 */
function loadEnvLocal() {
	const envPath = path.join(REPO_ROOT, ".env.local");
	if (!fs.existsSync(envPath)) return;

	const raw = fs.readFileSync(envPath, "utf8");
	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const eqIndex = line.indexOf("=");
		if (eqIndex === -1) continue;

		const key = line.slice(0, eqIndex).trim();
		if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		if (process.env[key] !== undefined) continue;

		let value = line.slice(eqIndex + 1).trim();
		if (
			(value.startsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.length >= 2)
		) {
			const quote = value[0];
			const closingIndex = value.indexOf(quote, 1);
			if (closingIndex !== -1) {
				value = value.slice(1, closingIndex);
			} else {
				value = value.slice(1);
			}
		}
		process.env[key] = value;
	}
}

function base64url(input) {
	const buffer = typeof input === "string" ? Buffer.from(input) : input;
	return buffer
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function signPayload(payload, secret) {
	const body = base64url(JSON.stringify(payload));
	const signature = base64url(
		crypto.createHmac("sha256", secret).update(body).digest(),
	);
	return `${body}.${signature}`;
}

function main() {
	loadEnvLocal();

	const role = process.argv[2];
	const returnTo = process.argv[3] ?? "/workspace";

	if (!role || !VALID_ROLES.has(role)) {
		console.error(
			"Usage: node scripts/e2e-login-url.mjs <tenant_owner|closer1> [returnTo]",
		);
		process.exit(1);
	}

	if (!returnTo.startsWith("/") || returnTo.startsWith("//")) {
		fail("returnTo must be an app-relative path that starts with a single '/'.");
	}

	if (process.env.E2E_AUTH_ENABLED !== "1") {
		fail(
			"E2E_AUTH_ENABLED must be '1' to sign a test login URL. " +
				"Add E2E_AUTH_ENABLED=1 to .env.local and restart the dev server.",
		);
	}

	const secret = process.env.E2E_AUTH_TOKEN_SECRET;
	if (!secret || secret.length < 32) {
		fail(
			"E2E_AUTH_TOKEN_SECRET is missing or shorter than 32 chars. " +
				"Generate one with: openssl rand -base64 48",
		);
	}

	const orgId = process.env.E2E_TEST_TENANT_WORKOS_ORG_ID;
	if (!orgId || !orgId.startsWith("org_")) {
		fail(
			"E2E_TEST_TENANT_WORKOS_ORG_ID is missing or not a WorkOS org id (must start with 'org_'). " +
				"Check .env.local for stray quotes or concatenated values.",
		);
	}

	const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

	const now = Date.now();
	const payload = {
		typ: "magnus.e2e.login",
		role,
		orgId,
		returnTo,
		iat: now,
		exp: now + TOKEN_TTL_MS,
		nonce: crypto.randomUUID(),
	};

	const token = signPayload(payload, secret);

	const url = new URL("/api/testing/auth/login", appUrl);
	url.searchParams.set("token", token);

	console.log(url.toString());
}

main();
