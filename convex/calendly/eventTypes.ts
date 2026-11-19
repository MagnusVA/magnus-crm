"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { action, internalAction } from "../_generated/server";
import { bookingUrlKey } from "../lib/closerLinks";
import { describeError, log } from "../lib/observability/log";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { CALENDLY_FETCH_TIMEOUT_MS, calendlyHttpError } from "./apiErrors";
import {
  HOST_CHECK_PHASE_MS,
  HOST_RESULTS_PER_BATCH,
  isHostCheckCandidate,
  runHostChecks,
} from "./eventTypeHosts";
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

/** What the round-robin host check did, reported to the admin who synced. */
type HostCheckTotals = {
  hostsChecked: number;
  hostsSingle: number;
  /**
   * Asked but unproven, or live closer links never reached: their closer
   * links pause until a sync verifies them.
   */
  hostsUnverified: number;
  /** Other round robins never reached (quota, deadline or outage): their stored host is kept. */
  hostsUnchecked: number;
};

type ManualEventTypeSyncResult =
  | ({ status: "success" } & EventTypeSyncTotals & HostCheckTotals)
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
/** The lock is extended to at least this long when the host check starts. */
const HOST_CHECK_LOCK_MS = 3 * 60 * 1000;
/** Time kept on the lock after the host check, to write and finish. */
const HOST_CHECK_LOCK_MARGIN_MS = 30 * 1000;
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

/**
 * The `reason` arg is a free string; logs carry this bounded version.
 * `manual_admin` is the only caller today.
 */
type EventTypeSyncTrigger = "manual_admin" | "unspecified" | "other";

function toSyncTrigger(reason: string | undefined): EventTypeSyncTrigger {
  if (reason === undefined) return "unspecified";
  return reason === "manual_admin" ? "manual_admin" : "other";
}

function calendlyRateLimitMessage(response: Response) {
  const resetSeconds =
    response.headers.get("X-RateLimit-Reset") ??
    response.headers.get("Retry-After");
  if (!resetSeconds) {
    return "Calendly rate limited event type sync (HTTP 429). Try again later.";
  }
  return `Calendly rate limited event type sync (HTTP 429). Try again in ${resetSeconds} seconds.`;
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
    signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
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
  syncLockUntil: number;
  source: EventTypeSyncSource;
  accessToken: string;
  seenEventTypeUris: Set<string>;
  /** Round robins to ask Calendly the hosts of, with their booking URL. */
  hostCandidates: Map<string, string | undefined>;
  /** The latest `X-RateLimit-Remaining` Calendly sent. */
  rateLimit: { remaining: number | null };
  totals: EventTypeSyncTotals;
  /** Resources skipped across the whole sync, logged once in the summary. */
  skipped: { missingUri: number };
}) {
  let accessToken = args.accessToken;
  let nextPage: string | null = args.source.firstPageUrl;
  const visitedPages = new Set<string>();

  while (nextPage) {
    if (visitedPages.has(nextPage)) {
      throw new Error("Calendly event type pagination loop detected.");
    }
    visitedPages.add(nextPage);

    const fetchResult = await fetchEventTypesPageWithRefresh(
      args.ctx,
      args.tenantId,
      nextPage,
      accessToken,
    );
    accessToken = fetchResult.accessToken;
    const response = fetchResult.response;
    const remaining = Number(response.headers.get("X-RateLimit-Remaining") ?? Number.NaN);
    if (Number.isFinite(remaining)) args.rateLimit.remaining = remaining;

    if (response.status === 429) {
      throw new Error(calendlyRateLimitMessage(response));
    }
    if (response.status === 403) {
      throw new Error(
        args.source.kind === "user"
          ? `Calendly denied event type access for user ${args.source.userUri} (HTTP 403).`
          : "Calendly denied organization event type access (HTTP 403). Reconnect Calendly with an owner or admin account.",
      );
    }
    if (!response.ok) {
      throw await calendlyHttpError("event type sync", response);
    }

    const page = parseCalendlyEventTypesPage(await response.json());
    const newResources: unknown[] = [];
    for (const resource of page.collection) {
      const resourceUri = getEventTypeResourceUri(resource);
      if (!resourceUri) {
        args.skipped.missingUri += 1;
        continue;
      }
      if (args.seenEventTypeUris.has(resourceUri)) {
        continue;
      }
      args.seenEventTypeUris.add(resourceUri);
      newResources.push(resource);
      if (isHostCheckCandidate(resource)) {
        const schedulingUrl = resource.scheduling_url;
        args.hostCandidates.set(
          resourceUri,
          typeof schedulingUrl === "string" ? schedulingUrl : undefined,
        );
      }
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
          syncLockUntil: args.syncLockUntil,
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
  syncLockUntil: number,
  totals: EventTypeSyncTotals,
  hosts: HostCheckTotals,
  logAttrs: { trigger: EventTypeSyncTrigger; skippedMissingUri: number },
) {
  const stale: { notReturned: number } = await ctx.runMutation(
    internal.calendly.eventTypeMutations.markMissingEventTypes,
    { tenantId, syncStartedAt: startedAt, syncLockUntil },
  );
  const summary: EventTypeSyncTotals = { ...totals, ...stale };

  await ctx.runMutation(
    internal.calendly.eventTypeMutations.completeEventTypeSync,
    { tenantId, syncLockUntil, status: "success", totals: summary },
  );

  const unconfirmedHosts = hosts.hostsUnverified + hosts.hostsUnchecked;
  (unconfirmedHosts > 0 ? log.warn : log.info)("calendly.event_types.sync", {
    tenantId,
    outcome: "success",
    durationMs: Date.now() - startedAt,
    ...logAttrs,
    ...summary,
    ...hosts,
  });

  return { status: "success" as const, ...summary, ...hosts };
}

/**
 * Asks Calendly who hosts each round robin the sync listed, and stores the
 * only host where there is exactly one. Live closer links go first. A 429
 * stores what was learned, then fails the sync as a listing 429 does.
 */
async function syncEventTypeHosts(args: {
  ctx: ActionCtx;
  tenantId: Id<"tenants">;
  syncStartedAt: number;
  /** The run's lock token, updated in place when the check extends the lock. */
  lock: { syncLockUntil: number };
  accessToken: string;
  candidates: Map<string, string | undefined>;
  rateLimitRemaining: number | null;
}): Promise<HostCheckTotals> {
  const { ctx, tenantId, lock } = args;
  const empty: HostCheckTotals = { hostsChecked: 0, hostsSingle: 0, hostsUnverified: 0, hostsUnchecked: 0 };
  if (args.candidates.size === 0) return empty;

  const liveKeys = new Set<string>(
    await ctx.runQuery(internal.calendly.eventTypeMutations.listCloserLinkUrlKeys, { tenantId }),
  );
  const live: string[] = [];
  const rest: string[] = [];
  for (const [uri, schedulingUrl] of args.candidates) {
    const key = bookingUrlKey(schedulingUrl);
    (key !== null && liveKeys.has(key) ? live : rest).push(uri);
  }
  // Shuffled, so a sync cut short doesn't skip the same event types each time.
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }

  const phaseStart = Date.now();
  const extended: { syncLockUntil: number } = await ctx.runMutation(
    internal.calendly.eventTypeMutations.extendEventTypeSyncLock,
    { tenantId, syncLockUntil: lock.syncLockUntil, minLockUntil: phaseStart + HOST_CHECK_LOCK_MS },
  );
  lock.syncLockUntil = extended.syncLockUntil;
  const syncLockUntil = lock.syncLockUntil;

  const result = await runHostChecks({
    candidates: [...live, ...rest],
    accessToken: args.accessToken,
    rateLimitRemaining: args.rateLimitRemaining,
    deadline: Math.min(phaseStart + HOST_CHECK_PHASE_MS, syncLockUntil - HOST_CHECK_LOCK_MARGIN_MS),
    deps: {
      fetch: (url, accessToken, timeoutMs) =>
        fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        }),
      refreshToken: async () => (await refreshTenantTokenCore(ctx, tenantId)).accessToken ?? null,
      now: () => Date.now(),
    },
  });

  const writes: Array<{ eventTypeUri: string; soleHostUri?: string }> = [];
  const hosts = { ...empty };
  // A live closer link the check didn't reach is paused, not left on old
  // proof: Calendly may have added a host since. Others keep their host.
  const liveSet = new Set(live);
  for (const eventTypeUri of result.unchecked) {
    if (liveSet.has(eventTypeUri)) {
      writes.push({ eventTypeUri });
      hosts.hostsUnverified += 1;
    } else {
      hosts.hostsUnchecked += 1;
    }
  }
  for (const [eventTypeUri, verdict] of result.verdicts) {
    hosts.hostsChecked += 1;
    if (verdict.kind === "single") hosts.hostsSingle += 1;
    if (verdict.kind === "failed") hosts.hostsUnverified += 1;
    writes.push(
      verdict.kind === "single" ? { eventTypeUri, soleHostUri: verdict.hostUri } : { eventTypeUri },
    );
  }
  for (let start = 0; start < writes.length; start += HOST_RESULTS_PER_BATCH) {
    await ctx.runMutation(internal.calendly.eventTypeMutations.recordEventTypeHosts, {
      tenantId,
      syncStartedAt: args.syncStartedAt,
      syncLockUntil,
      results: writes.slice(start, start + HOST_RESULTS_PER_BATCH),
    });
  }

  log.info("calendly.event_types.hosts", {
    tenantId,
    live: live.length,
    candidates: args.candidates.size,
    stoppedBy: result.stoppedBy ?? undefined,
    durationMs: Date.now() - phaseStart,
    ...hosts,
  });
  if (result.rateLimitResponse) {
    throw new Error(calendlyRateLimitMessage(result.rateLimitResponse));
  }
  return hosts;
}

export const syncForTenant = internalAction({
  args: {
    tenantId: v.id("tenants"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { tenantId, reason }) => {
    const startedAt = Date.now();
    const trigger = toSyncTrigger(reason);
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
      log.warn("calendly.event_types.sync", {
        tenantId,
        trigger,
        outcome: "skipped",
        reason: "lock_held",
        lockedForMs: lock.lockUntil ? lock.lockUntil - startedAt : undefined,
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
    const skipped = { missingUri: 0 };
    // The lock's expiry is this run's token; extending it replaces the token.
    const runLock = { syncLockUntil: lock.lockUntil ?? startedAt + EVENT_TYPE_SYNC_LOCK_MS };

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
      const hostCandidates = new Map<string, string | undefined>();
      const rateLimit: { remaining: number | null } = { remaining: null };

      for (const source of sources) {
        accessToken = await syncEventTypesSource({
          ctx,
          tenantId,
          syncStartedAt: startedAt,
          syncLockUntil: runLock.syncLockUntil,
          source,
          accessToken,
          seenEventTypeUris,
          hostCandidates,
          rateLimit,
          totals,
          skipped,
        });
      }

      const hosts = await syncEventTypeHosts({
        ctx,
        tenantId,
        syncStartedAt: startedAt,
        lock: runLock,
        accessToken,
        candidates: hostCandidates,
        rateLimitRemaining: rateLimit.remaining,
      });

      return await finalizeSuccessfulSync(
        ctx,
        tenantId,
        startedAt,
        runLock.syncLockUntil,
        totals,
        hosts,
        { trigger, skippedMissingUri: skipped.missingUri },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await ctx.runMutation(
        internal.calendly.eventTypeMutations.completeEventTypeSync,
        {
          tenantId,
          syncLockUntil: runLock.syncLockUntil,
          status: "failed",
          error: message,
        },
      );
      // Rethrown, so the failed execution is reported on its own; this line
      // records the outcome and the progress made before the failure.
      log.error("calendly.event_types.sync", {
        tenantId,
        trigger,
        outcome: "failed",
        durationMs: Date.now() - startedAt,
        errorName: describeError(error).name,
        skippedMissingUri: skipped.missingUri,
        ...totals,
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
    const access = await requireTenantUserFromAction(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // syncForTenant logs the outcome as `calendly.event_types.sync`.
    return await ctx.runAction(internal.calendly.eventTypes.syncForTenant, {
      tenantId: access.tenantId,
      reason: "manual_admin",
    });
  },
});
