import type { HttpRouter } from "convex/server";
import type { McpAuthorizerHandler } from "convex-mcp-gateway";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { components, internal } from "../_generated/api";
import { env, httpAction, type ActionCtx } from "../_generated/server";
import { log } from "../lib/observability/log";
import { gateway, mcpRateLimiter } from "./gateway";
import { MCP_CLIENT_CLAIM } from "./guard";
import { closerInstructions } from "./instructions";
import { closerTools } from "./toolsets/closer";
import { handleProofUpload } from "./uploads";

/**
 * The MCP endpoint (docs/plans/closer-assistant.md §6.1).
 *
 * AuthKit is the OAuth server for MCP clients. Its access tokens are verified
 * here, against AuthKit's JWKS with the MCP URL as the audience, instead of
 * through `auth.config.ts`: Convex refuses an auth config that reads an unset
 * variable, and these two stay optional so a deployment without them still
 * deploys. Without both, every MCP route answers 404.
 *
 * Tools run inside the gateway component, where `ctx.auth` is empty. The
 * gateway injects the verified caller into each tool's `caller` argument,
 * and `requireMcpUser` resolves the Magnus user from it.
 */

type McpConfig = { issuer: string; resource: string };

function mcpConfig(): McpConfig | null {
  const issuer = env.AUTHKIT_DOMAIN?.trim().replace(/\/+$/, "");
  const resource = env.MCP_RESOURCE_URL?.trim();
  return issuer && resource ? { issuer, resource } : null;
}

// One JWKS fetcher per isolate; jose caches the keys and refetches on an
// unknown `kid`.
let jwks: { issuer: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;
function jwksFor(issuer: string) {
  if (!jwks || jwks.issuer !== issuer) {
    jwks = { issuer, set: createRemoteJWKSet(new URL(`${issuer}/oauth2/jwks`)) };
  }
  return jwks.set;
}

export async function verifyMcpAccessToken(
  token: string,
  config: McpConfig,
  keys: Parameters<typeof jwtVerify>[1] = jwksFor(config.issuer),
): Promise<(JWTPayload & { sub: string }) | null> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: config.resource,
      algorithms: ["RS256"],
    });
    return typeof payload.sub === "string" && payload.sub ? (payload as JWTPayload & { sub: string }) : null;
  } catch {
    return null;
  }
}

// The protected-resource metadata and the 401 challenge read the gateway's
// stored OAuth config. Keep it equal to the variables: one cheap read per
// request, and a write only when they changed.
async function ensureOAuthConfig(ctx: ActionCtx, config: McpConfig) {
  const stored = (await ctx.runQuery(components.mcpGateway.registry.getOAuthConfig, {})) as {
    authServerUrl?: string;
    resourceUrl?: string | null;
  } | null;
  if (stored?.authServerUrl === config.issuer && stored?.resourceUrl === config.resource) return;
  await gateway.setOAuthConfig(ctx, { authServerUrl: config.issuer, resourceUrl: config.resource });
}

type RpcPeek = { method?: string; toolName?: string; clientName?: string; clientVersion?: string };

/** Reads what the wrapper needs from a JSON-RPC body without consuming it. */
async function peekRpc(request: Request): Promise<RpcPeek> {
  if (request.method !== "POST") return {};
  try {
    const body: unknown = await request.clone().json();
    const message = (Array.isArray(body) ? body[0] : body) as {
      method?: unknown;
      params?: Record<string, unknown>;
    } | null;
    if (!message || typeof message !== "object") return {};
    const params = (message.params ?? {}) as Record<string, unknown>;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    // Legacy sessions send clientInfo on initialize; stateless requests carry
    // it in _meta on every call.
    const info = (params.clientInfo ?? meta["io.modelcontextprotocol/clientInfo"]) as
      | { name?: unknown; version?: unknown }
      | undefined;
    return {
      method: typeof message.method === "string" ? message.method : undefined,
      toolName: typeof params.name === "string" ? params.name : undefined,
      clientName: typeof info?.name === "string" ? info.name : undefined,
      clientVersion: typeof info?.version === "string" ? info.version : undefined,
    };
  } catch {
    return {};
  }
}

/** A CIMD client ID is a URL, such as https://claude.ai/oauth/mcp-client.json. */
function clientFromClientId(clientId: unknown): string | undefined {
  if (typeof clientId !== "string") return undefined;
  try {
    return new URL(clientId).hostname;
  } catch {
    return undefined;
  }
}

type CallerAccess =
  | { ok: true; userId: string; role: string; fullName: string; companyName: string; timeZone: string }
  | { ok: false; code: string; message: string };

const handleMcp = httpAction(async (ctx, request) => {
  const config = mcpConfig();
  if (!config) return new Response("Not found", { status: 404 });
  await ensureOAuthConfig(ctx, config);

  const started = Date.now();
  const rpc = await peekRpc(request);
  const sessionId = request.headers.get("mcp-session-id");
  let clientName = rpc.clientName;
  if (!clientName && sessionId) {
    clientName = (await ctx.runQuery(internal.mcp.access.getClientSession, { sessionId })) ?? undefined;
  }

  // Verified once per request; the gateway asks for it, and so does the
  // initialize branch below.
  let verified: Promise<{ subject: string; claims: Record<string, unknown> } | null> | null = null;
  const resolveIdentity = (token: string) => {
    verified ??= verifyMcpAccessToken(token, config).then((payload) =>
      payload
        ? {
            subject: payload.sub,
            claims: {
              ...payload,
              tokenIdentifier: `${config.issuer}|${payload.sub}`,
              [MCP_CLIENT_CLAIM]: clientName ?? clientFromClientId(payload.client_id) ?? "unknown",
            },
          }
        : null,
    );
    return verified;
  };

  // `tools/list` asks once per tool; check the caller once per request.
  const accessBySubject = new Map<string, Promise<CallerAccess>>();
  const accessFor = (identity: { subject: string; claims?: Record<string, unknown> }) => {
    let access = accessBySubject.get(identity.subject);
    if (!access) {
      access = ctx.runQuery(internal.mcp.access.checkCaller, { caller: identity }) as Promise<CallerAccess>;
      accessBySubject.set(identity.subject, access);
    }
    return access;
  };

  let rateLimited = false;
  const authorize: McpAuthorizerHandler = async (_ctx, { identity, mode, toolMetadata }) => {
    if (!identity) return { allowed: false, reason: "Unauthorized" };
    const access = await accessFor(identity);
    if (!access.ok) return { allowed: false, reason: access.message };
    const roles = (toolMetadata as { roles?: string[] } | null)?.roles ?? [];
    if (!roles.includes(access.role)) {
      return { allowed: false, reason: "This tool isn't available for your role." };
    }
    if (mode === "call") {
      const limit = await mcpRateLimiter.limit(ctx, "mcpCall", { key: access.userId });
      if (!limit.ok) {
        rateLimited = true;
        return { allowed: false, reason: "Too many requests in a minute. Try again shortly." };
      }
    }
    return { allowed: true };
  };

  let instructions = closerInstructions(null);
  if (rpc.method === "initialize") {
    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    const identity = token ? await resolveIdentity(token) : null;
    const access = identity ? await accessFor(identity) : null;
    if (access?.ok) instructions = closerInstructions(access);
  }

  const response = await gateway.handleMcpRequest(ctx, request, {
    authorize,
    resolveIdentity,
    tools: closerTools,
    requireAuth: true,
    initializeInstructions: instructions,
  });

  if (rpc.method === "initialize" && clientName) {
    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) {
      await ctx.runMutation(internal.mcp.access.recordClientSession, {
        sessionId: newSessionId,
        clientName,
        ...(rpc.clientVersion ? { clientVersion: rpc.clientVersion } : {}),
      });
    }
  }

  log.info("mcp.request", {
    method: rpc.method ?? request.method,
    tool: rpc.toolName,
    client: clientName,
    status: response.status,
    rateLimited,
    durationMs: Date.now() - started,
  });
  return response;
});

const protectedResourceMetadata = httpAction(async (ctx, request) => {
  const config = mcpConfig();
  if (!config) return new Response("Not found", { status: 404 });
  await ensureOAuthConfig(ctx, config);
  return gateway.serveProtectedResourceMetadata(ctx, request);
});

export function registerMcpRoutes(http: HttpRouter) {
  // Some clients (claude.ai) strip the trailing slash; mount both.
  for (const path of ["/mcp", "/mcp/"]) {
    for (const method of ["POST", "GET", "DELETE"] as const) {
      http.route({ path, method, handler: handleMcp });
    }
  }
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    http.route({ path, method: "GET", handler: protectedResourceMetadata });
    http.route({ path, method: "OPTIONS", handler: protectedResourceMetadata });
  }
  // Single-use proof uploads for agents with a shell (§6.3).
  http.route({ pathPrefix: "/mcp/uploads/", method: "POST", handler: handleProofUpload });
}
