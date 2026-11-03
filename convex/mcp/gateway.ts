import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { McpGateway } from "convex-mcp-gateway";
import { components } from "../_generated/api";

/** The MCP gateway component: sessions, tool registry and audit log. */
export const gateway = new McpGateway(components.mcpGateway);

/**
 * 60 MCP calls a minute per user, with bursts of 20: the external API's
 * limit, enough for any person and low enough to stop an agent stuck in a
 * loop (docs/plans/closer-assistant.md §6.8).
 */
export const mcpRateLimiter = new RateLimiter(components.rateLimiter, {
  mcpCall: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 20 },
});
