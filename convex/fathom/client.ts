import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { timeoutSignal } from "../lib/timeoutSignal";
import { log } from "../lib/observability/log";

// Base URL and X-Api-Key: https://developers.fathom.ai/api-reference/meetings/list-meetings
// Limits and Retry-After: https://developers.fathom.ai/api-overview
// Fathom allows 60 global requests/minute and 30 heavy requests/minute, sometimes
// reduced to 5. Magnus reserves all requests 2100ms apart and honors Retry-After.
export const FATHOM_BASE = "https://api.fathom.ai/external/v1";
export class FathomRetry extends Error {
  constructor(
    public delayMs: number,
    public status?: number,
  ) {
    super(
      status
        ? `Fathom request failed: HTTP ${status}`
        : "Fathom request waiting for rate limit",
    );
  }
}
export async function fathomFetch(
  ctx: ActionCtx,
  connectionId: Id<"tenantFathomConnections">,
  key: string,
  path: string,
  init: RequestInit = {},
  allowed: number[] = [],
): Promise<Response> {
  const at: number = await ctx.runMutation(
    internal.fathom.state.reserveRequest,
    { connectionId },
  );
  const wait = at - Date.now();
  if (wait > 45_000) throw new FathomRetry(wait);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const response = await fetch(`${FATHOM_BASE}${path}`, {
    ...init,
    headers: {
      "X-Api-Key": key,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: timeoutSignal(20_000),
  });
  log.info("fathom.api.response", { connectionId, status: response.status });
  if (!response.ok && !allowed.includes(response.status)) {
    const seconds = Number(response.headers.get("Retry-After"));
    const delayMs = Math.max(
      60_000,
      Number.isFinite(seconds) ? seconds * 1000 : 0,
    );
    await ctx.runMutation(internal.fathom.state.failure, {
      connectionId,
      apiKey: key,
      status: response.status,
      ...(response.status === 429 ? { retryAt: Date.now() + delayMs } : {}),
    });
    if (response.status === 429 || response.status >= 500)
      throw new FathomRetry(delayMs, response.status);
    throw new Error(`Fathom request failed: HTTP ${response.status}`);
  }
  return response;
}
// Roster items and next_cursor: https://developers.fathom.ai/api-reference/team-members/list-team-members
// Optional permission levels: https://developers.fathom.ai/api-reference/users/list-users-and-their-permissions
const rosterItem = z.object({
  email: z.string(),
  name: z.string().nullish(),
  permissions: z
    .object({
      view_access: z.object({ level: z.string() }),
      settings_access: z.object({ level: z.string() }),
    })
    .optional(),
});
export const rosterPage = z.object({
  items: z.array(rosterItem).max(200),
  next_cursor: z.string().nullable(),
});
export function rosterFields(data: z.infer<typeof rosterPage>) {
  return data.items.map((i) => ({
    email: i.email,
    name: i.name ?? undefined,
    viewAccessLevel: i.permissions?.view_access.level,
    settingsAccessLevel: i.permissions?.settings_access.level,
  }));
}
