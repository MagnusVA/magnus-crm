"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { action, internalAction } from "../_generated/server";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { getValidAccessToken, refreshTenantTokenCore } from "./tokens";

type TenantEventTypeSyncContext = {
  organizationUri?: string;
  userUri?: string;
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

type ManualEventTypeSyncResult =
  | ({ status: "success" } & EventTypeSyncTotals)
  | {
      status: "skipped";
      reason: "lock_held";
    };

type CalendlyEventTypesPage = {
  collection: unknown[];
  nextPage: string | null;
};

type EventTypeSyncSource = {
  kind: "organization" | "user";
  userUri?: string;
  firstPageUrl: string;
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

function buildFirstUserEventTypesPageUrl(
  organizationUri: string,
  userUri: string,
) {
  return `${CALENDLY_EVENT_TYPES_URL}?organization=${encodeURIComponent(
    organizationUri,
  )}&user=${encodeURIComponent(userUri)}&count=100`;
}

function getEventTypeResourceUri(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  return typeof value.uri === "string" && value.uri.length > 0
    ? value.uri
    : null;
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

async function fetchEventTypesPageWithRefresh(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
  url: string,
  accessToken: string,
) {
  let response = await fetchEventTypesPage(url, accessToken);
  if (response.status !== 401) {
    return { response, accessToken };
  }

  const refreshed = await refreshTenantTokenCore(ctx, tenantId);
  if (!refreshed.refreshed) {
    return { response, accessToken };
  }

  response = await fetchEventTypesPage(url, refreshed.accessToken);
  return { response, accessToken: refreshed.accessToken };
}

function buildEventTypeSyncSources(args: {
  organizationUri: string;
  connectionUserUri?: string;
  memberUserUris: string[];
}) {
  const sources: EventTypeSyncSource[] = [
    {
      kind: "organization",
      firstPageUrl: buildFirstEventTypesPageUrl(args.organizationUri),
    },
  ];

  const userUris = new Set<string>();
  if (args.connectionUserUri) {
    userUris.add(args.connectionUserUri);
  }
  for (const userUri of args.memberUserUris) {
    userUris.add(userUri);
  }

  for (const userUri of userUris) {
    sources.push({
      kind: "user",
      userUri,
      firstPageUrl: buildFirstUserEventTypesPageUrl(
        args.organizationUri,
        userUri,
      ),
    });
  }

  return sources;
}

async function syncEventTypesSource(args: {
  ctx: ActionCtx;
  tenantId: Id<"tenants">;
  syncStartedAt: number;
  source: EventTypeSyncSource;
  accessToken: string;
  seenEventTypeUris: Set<string>;
  totals: EventTypeSyncTotals;
}) {
  let accessToken = args.accessToken;
  let nextPage: string | null = args.source.firstPageUrl;
  const visitedPages = new Set<string>();

  while (nextPage) {
    if (visitedPages.has(nextPage)) {
      throw new Error("Calendly event type pagination loop detected.");
    }
    visitedPages.add(nextPage);

    console.log("[Calendly:EventTypes] fetching page", {
      tenantId: args.tenantId,
      source: args.source.kind,
      userUri: args.source.userUri,
      page: visitedPages.size,
    });

    const fetchResult = await fetchEventTypesPageWithRefresh(
      args.ctx,
      args.tenantId,
      nextPage,
      accessToken,
    );
    accessToken = fetchResult.accessToken;
    const response = fetchResult.response;

    if (response.status === 429) {
      throw new Error(calendlyRateLimitMessage(response));
    }
    if (response.status === 403) {
      throw new Error(
        args.source.kind === "user"
          ? `Calendly denied event type access for user ${args.source.userUri}.`
          : "Calendly denied organization event type access. Reconnect Calendly with an owner or admin account.",
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
    const newResources: unknown[] = [];
    for (const resource of page.collection) {
      const resourceUri = getEventTypeResourceUri(resource);
      if (!resourceUri) {
        console.warn("[Calendly:EventTypes] skipping resource without uri", {
          tenantId: args.tenantId,
          source: args.source.kind,
          userUri: args.source.userUri,
        });
        continue;
      }
      if (args.seenEventTypeUris.has(resourceUri)) {
        continue;
      }
      args.seenEventTypeUris.add(resourceUri);
      newResources.push(resource);
    }

    if (newResources.length > 0) {
      const result: {
        created: number;
        updated: number;
        unchanged: number;
        inactive: number;
        deleted: number;
        questionsMerged: number;
      } = await args.ctx.runMutation(
        internal.calendly.eventTypeMutations.upsertEventTypesPage,
        {
          tenantId: args.tenantId,
          syncStartedAt: args.syncStartedAt,
          collection: newResources,
        },
      );

      args.totals.totalSeen += newResources.length;
      args.totals.created += result.created;
      args.totals.updated += result.updated;
      args.totals.unchanged += result.unchanged;
      args.totals.inactive += result.inactive;
      args.totals.deleted += result.deleted;
      args.totals.questionsMerged += result.questionsMerged;
    }

    nextPage = page.nextPage;
  }

  return accessToken;
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
      await ctx.runMutation(
        internal.calendly.eventTypeMutations.completeEventTypeSync,
        {
          tenantId,
          status: "skipped",
          error: "An event type sync is already running.",
        },
      );
      return {
        status: "skipped" as const,
        reason: "lock_held" as const,
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

      const memberUserUris: string[] = await ctx.runQuery(
        internal.calendly.orgMembersQueries.listMemberUserUrisForTenant,
        { tenantId },
      );
      const sources = buildEventTypeSyncSources({
        organizationUri: tenant.organizationUri,
        connectionUserUri: tenant.userUri,
        memberUserUris,
      });
      const seenEventTypeUris = new Set<string>();

      console.log("[Calendly:EventTypes] sync sources prepared", {
        tenantId,
        sourceCount: sources.length,
        memberUserCount: memberUserUris.length,
      });

      for (const source of sources) {
        accessToken = await syncEventTypesSource({
          ctx,
          tenantId,
          syncStartedAt: startedAt,
          source,
          accessToken,
          seenEventTypeUris,
          totals,
        });
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

/**
 * Public manual event type sync trigger for tenant admins.
 *
 * OAuth completion, Calendly webhooks, and recurring jobs intentionally do not
 * call the internal sync implementation in this MVP.
 */
export const syncMyTenantEventTypes = action({
  args: {},
  handler: async (ctx): Promise<ManualEventTypeSyncResult> => {
    console.log("[Calendly:EventTypes] syncMyTenantEventTypes called");

    const access = await requireTenantUserFromAction(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const result: ManualEventTypeSyncResult = await ctx.runAction(
      internal.calendly.eventTypes.syncForTenant,
      {
        tenantId: access.tenantId,
        reason: "manual_admin",
      },
    );

    if (result.status === "skipped") {
      console.log("[Calendly:EventTypes] manual sync skipped", {
        tenantId: access.tenantId,
        reason: result.reason,
      });
      return result;
    }

    console.log("[Calendly:EventTypes] manual sync complete", {
      tenantId: access.tenantId,
      totalSeen: result.totalSeen,
      created: result.created,
      updated: result.updated,
    });
    return result;
  },
});
