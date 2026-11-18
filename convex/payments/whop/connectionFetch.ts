import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { log } from "../../lib/observability/log";
import { WhopRequestError, whopRequest } from "./client";

export class WhopAccountMismatch extends Error {
  constructor() {
    super("Whop account mismatch");
  }
}

type FetchOptions = NonNullable<Parameters<typeof whopRequest>[2]> & { connectedAt?: number };

export async function whopFetch<T = unknown>(
  ctx: ActionCtx,
  connectionId: Id<"tenantPaymentConnections">,
  path: string,
  init: FetchOptions = {},
  parse?: (response: unknown) => T,
): Promise<T> {
  const { connectedAt: expectedConnectedAt, ...requestInit } = init;
  const connectedAt = expectedConnectedAt ??
    (await ctx.runQuery(internal.payments.connectionState.connection, { connectionId }))?.connectedAt;
  if (connectedAt === undefined) throw new WhopRequestError("unauthorized");
  const waitUntil = Date.now() + 1_000;
  while (true) {
    const slot = await ctx.runMutation(internal.payments.connectionState.reserveRequest, {
      connectionId,
      connectedAt,
    });
    if (slot.state === "unavailable") throw new WhopRequestError("unauthorized");
    if (slot.state === "waiting") {
      const delay = slot.retryAt - Date.now();
      if (slot.retryAt > waitUntil || Date.now() >= waitUntil)
        throw new WhopRequestError("rate_limited", undefined, Math.max(delay, 150));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    let result: T;
    try {
      const response = await whopRequest(slot.credentials, path, { timeoutMs: 8_000, ...requestInit });
      result = parse ? parse(response) : response as T;
    } catch (error) {
      const failure = error instanceof WhopRequestError
        ? error
        : new WhopRequestError("unexpected_response");
      const code = error instanceof WhopAccountMismatch ? "account_mismatch" : failure.code;
      await ctx.runMutation(internal.payments.connectionState.recordFailure, {
        connectionId,
        connectedAt,
        code,
        retryAfterMs: failure.retryAfterMs,
      });
      log.warn("whop.api.failed", { connectionId, code, httpStatus: failure.status });
      throw error instanceof WhopAccountMismatch ? error : failure;
    }

    await ctx.runMutation(internal.payments.connectionState.recordSuccess, {
      connectionId,
      connectedAt,
      requestedAt: slot.requestedAt,
    });
    return result;
  }
}
