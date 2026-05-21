"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { getValidAccessToken, refreshTenantTokenCore } from "./tokens";

type TenantEventTypeSyncContext = {
  organizationUri?: string;
  tenantStatus: string;
};

type EventTypeSyncTotals = {
  totalSeen: number;
  created: number;
  updated: number;
  unchanged: number;
  inactive: number;
  deleted: number;
  notReturned: number;
  questionsMerged: number;
};

type CalendlyEventTypesPage = {
  collection: unknown[];
  nextPage: string | null;
};

const EVENT_TYPE_SYNC_LOCK_MS = 5 * 60 * 1000;
const CALENDLY_EVENT_TYPES_URL = "https://api.calendly.com/event_types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCalendlyEventTypesPage(value: unknown): CalendlyEventTypesPage {
  if (!isRecord(value)) {
    throw new Error("Calendly event type sync returned an invalid page.");
  }

  if (!Array.isArray(value.collection)) {
    throw new Error("Calendly event type sync response was missing collection.");
  }

  let nextPage: string | null = null;
  if (isRecord(value.pagination)) {
    const rawNextPage = value.pagination.next_page;
    if (typeof rawNextPage === "string" && rawNextPage.length > 0) {
      nextPage = rawNextPage;
    }
  }

  return { collection: value.collection, nextPage };
}

async function readCalendlyError(response: Response) {
  const text = await response.text();
  return text.length > 1_000 ? `${text.slice(0, 1_000)}...` : text;
}

function calendlyRateLimitMessage(response: Response) {
  const resetSeconds =
    response.headers.get("X-RateLimit-Reset") ??
    response.headers.get("Retry-After");
  if (!resetSeconds) {
    return "Calendly rate limited event type sync. Try again later.";
  }
  return `Calendly rate limited event type sync. Try again in ${resetSeconds} seconds.`;
}

function buildFirstEventTypesPageUrl(organizationUri: string) {
  return `${CALENDLY_EVENT_TYPES_URL}?organization=${encodeURIComponent(
    organizationUri,
  )}&count=100`;
}

async function fetchEventTypesPage(
  url: string,
  accessToken: string,
): Promise<Response> {
  return await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
}

async function finalizeSuccessfulSync(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
  startedAt: number,
  totals: EventTypeSyncTotals,
) {
  const stale: { notReturned: number } = await ctx.runMutation(
    internal.calendly.eventTypeMutations.markMissingEventTypes,
    { tenantId, syncStartedAt: startedAt },
  );
  const summary: EventTypeSyncTotals = { ...totals, ...stale };

  await ctx.runMutation(
    internal.calendly.eventTypeMutations.completeEventTypeSync,
    { tenantId, status: "success", totals: summary },
  );

  console.log("[Calendly:EventTypes] sync success", {
    tenantId,
    ...summary,
  });

  return { status: "success" as const, ...summary };
}

export const syncForTenant = internalAction({
  args: {
    tenantId: v.id("tenants"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { tenantId, reason }) => {
    const startedAt = Date.now();
    const lock: { acquired: boolean; lockUntil?: number } =
      await ctx.runMutation(
        internal.calendly.eventTypeMutations.acquireEventTypeSyncLock,
        {
          tenantId,
          lockUntil: startedAt + EVENT_TYPE_SYNC_LOCK_MS,
          reason,
        },
      );

    if (!lock.acquired) {
      console.log("[Calendly:EventTypes] sync skipped; lock held", {
        tenantId,
        lockUntil: lock.lockUntil,
      });
      return {
        status: "skipped" as const,
        reason: "lock_held" as const,
        lockUntil: lock.lockUntil,
      };
    }

    const totals: EventTypeSyncTotals = {
      totalSeen: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      inactive: 0,
      deleted: 0,
      notReturned: 0,
      questionsMerged: 0,
    };

    try {
      let accessToken = await getValidAccessToken(ctx, tenantId);
      const tenant = (await ctx.runQuery(
        internal.calendly.connectionQueries.getTenantConnectionContext,
        { tenantId },
      )) as TenantEventTypeSyncContext | null;

      if (!accessToken || !tenant?.organizationUri) {
        throw new Error("Missing Calendly access token or organization URI.");
      }

      if (
        tenant.tenantStatus !== "active" &&
        tenant.tenantStatus !== "provisioning_webhooks"
      ) {
        throw new Error(
          `Tenant is not ready for Calendly event type sync: ${tenant.tenantStatus}`,
        );
      }

      let nextPage: string | null = buildFirstEventTypesPageUrl(
        tenant.organizationUri,
      );
      const visitedPages = new Set<string>();

      while (nextPage) {
        if (visitedPages.has(nextPage)) {
          throw new Error("Calendly event type pagination loop detected.");
        }
        visitedPages.add(nextPage);

        console.log("[Calendly:EventTypes] fetching page", {
          tenantId,
          page: visitedPages.size,
        });

        let response = await fetchEventTypesPage(nextPage, accessToken);
        if (response.status === 401) {
          const refreshed = await refreshTenantTokenCore(ctx, tenantId);
          if (refreshed.refreshed) {
            accessToken = refreshed.accessToken;
            response = await fetchEventTypesPage(nextPage, accessToken);
          }
        }

        if (response.status === 429) {
          throw new Error(calendlyRateLimitMessage(response));
        }
        if (response.status === 403) {
          throw new Error(
            "Calendly denied organization event type access. Reconnect Calendly with an owner or admin account.",
          );
        }
        if (!response.ok) {
          throw new Error(
            `Calendly event type sync failed: ${response.status} ${await readCalendlyError(
              response,
            )}`,
          );
        }

        const page = parseCalendlyEventTypesPage(await response.json());
        const result: {
          created: number;
          updated: number;
          unchanged: number;
          inactive: number;
          deleted: number;
          questionsMerged: number;
        } = await ctx.runMutation(
          internal.calendly.eventTypeMutations.upsertEventTypesPage,
          {
            tenantId,
            syncStartedAt: startedAt,
            collection: page.collection,
          },
        );

        totals.totalSeen += page.collection.length;
        totals.created += result.created;
        totals.updated += result.updated;
        totals.unchanged += result.unchanged;
        totals.inactive += result.inactive;
        totals.deleted += result.deleted;
        totals.questionsMerged += result.questionsMerged;

        nextPage = page.nextPage;
      }

      return await finalizeSuccessfulSync(ctx, tenantId, startedAt, totals);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await ctx.runMutation(
        internal.calendly.eventTypeMutations.completeEventTypeSync,
        {
          tenantId,
          status: "failed",
          error: message,
        },
      );
      console.error("[Calendly:EventTypes] sync failed", {
        tenantId,
        error: message,
      });
      throw error;
    }
  },
});
