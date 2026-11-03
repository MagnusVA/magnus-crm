import { convexTest } from "convex-test";
import mcpGatewayTest from "convex-mcp-gateway/test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { vi } from "vitest";
import schema from "../convex/schema";
import { convexTestModules } from "../convex/test.setup";
import type { Id } from "../convex/_generated/dataModel";
import { registerComponents } from "./bookingHarness";

/**
 * Test harness for the MCP endpoint (docs/plans/closer-assistant.md §11).
 * Signs AuthKit-shaped access tokens with a local key, serves its JWKS through
 * a stubbed fetch, and talks JSON-RPC to `/mcp` through `t.fetch`.
 */
export const ISSUER = "https://magnus-test.authkit.app";
export const RESOURCE = "https://test-deployment.convex.site/mcp";
export const CLIENT_ID = "client_test";
const UM = `https://api.workos.com/user_management/${CLIENT_ID}`;

let key: Promise<{ privateKey: CryptoKey; jwk: Record<string, unknown> }> | null = null;
function testKey() {
  key ??= generateKeyPair("RS256").then(async ({ publicKey, privateKey }) => ({
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" },
  }));
  return key;
}

export async function createMcpHarness() {
  vi.stubEnv("WORKOS_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("WORKOS_API_KEY", "sk_test");
  vi.stubEnv("WORKOS_WEBHOOK_SECRET", "whsec_test");
  vi.stubEnv("AUTHKIT_DOMAIN", ISSUER);
  vi.stubEnv("MCP_RESOURCE_URL", RESOURCE);

  // One key for the whole run: the endpoint caches AuthKit's JWKS per isolate.
  const { privateKey, jwk } = await testKey();
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${ISSUER}/oauth2/jwks`) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  });

  const t = convexTest(schema, convexTestModules);
  registerComponents(t);
  mcpGatewayTest.register(t, "mcpGateway");
  rateLimiterTest.register(t, "rateLimiter");

  const signToken = (sub: string, claims: Record<string, unknown> = {}, audience = RESOURCE) =>
    new SignJWT({ client_id: "https://claude.ai/oauth/mcp-client.json", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);

  return { t, signToken };
}

export type McpHarness = Awaited<ReturnType<typeof createMcpHarness>>;

/** A tenant with closers switched on, and one closer stored in the user-management form. */
export async function seedTenantWithCloser(
  t: McpHarness["t"],
  options: { mcpRoles?: Array<"closer"> ; workosUserId?: string; orgId?: string } = {},
) {
  return await t.run(async (ctx) => {
    const orgId = options.orgId ?? "org_test";
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Northwind Coaching",
      contactEmail: "owner@northwind.example",
      workosOrgId: orgId,
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    const ownerId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: `${UM}|user_owner`,
      email: "owner@northwind.example",
      fullName: "Morgan Lee",
      role: "tenant_master",
      isActive: true,
    });
    const closerId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: options.workosUserId ?? `${UM}|user_alex`,
      email: "alex@northwind.example",
      fullName: "Alex Rivera",
      role: "closer",
      isActive: true,
      timezone: "America/Tegucigalpa",
    });
    if (options.mcpRoles !== undefined ? options.mcpRoles.length > 0 : true) {
      await ctx.db.patch("tenants", tenantId, {
        mcpAccess: { roles: options.mcpRoles ?? ["closer"], changedAt: 0, changedByUserId: ownerId },
      });
    }
    return { tenantId, ownerId, closerId, orgId } as {
      tenantId: Id<"tenants">;
      ownerId: Id<"users">;
      closerId: Id<"users">;
      orgId: string;
    };
  });
}

let rpcId = 0;

/** One JSON-RPC call to /mcp. Parses a JSON or SSE response body. */
export async function mcpRpc(
  t: McpHarness["t"],
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
) {
  const response = await t.fetch("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    const data = text.trim().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .pop() ?? "null";
    body = JSON.parse(data);
  }
  return {
    status: response.status,
    headers: response.headers,
    body: body as { result?: Record<string, unknown>; error?: { code: number; message: string } } | null,
  };
}

/** initialize, then notifications/initialized; returns the session ID. */
export async function mcpConnect(t: McpHarness["t"], token: string, clientName = "claude-ai") {
  const init = await mcpRpc(t, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: clientName, version: "1.0.0" },
  });
  const sessionId = init.headers.get("mcp-session-id") ?? undefined;
  return { init, sessionId };
}

/** tools/call, returning the tool's structured result or its error text. */
export async function callTool(
  t: McpHarness["t"],
  token: string,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await mcpRpc(t, token, "tools/call", { name, arguments: args }, sessionId);
  const result = response.body?.result as
    | { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }
    | undefined;
  const text = result?.content?.find((c) => c.type === "text")?.text;
  let data: unknown = result?.structuredContent;
  if (data === undefined && text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { response, isError: Boolean(result?.isError), data, text };
}
