import { PostHog } from "@posthog/convex";
import { components } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { env, type MutationCtx } from "../../_generated/server";
import type { EmitDomainEventParams } from "../domainEvents";
import { getRawWorkosUserId } from "../workosUserId";

/**
 * PostHog client for committed business events.
 *
 * `capture` schedules the send with `ctx.scheduler`, so an event captured in
 * a mutation is sent only if the mutation commits. That makes it the right
 * tool for "this happened" events, and the wrong one for errors: a mutation
 * that throws discards its scheduled sends. Errors reach PostHog through the
 * log stream instead (see `./log.ts`).
 */
export const posthog = new PostHog(components.posthog);

/** `POSTHOG_PROJECT_TOKEN=disabled` (or anything but a `phc_` token) turns capture off. */
export function isServerCaptureEnabled(): boolean {
  // Typed as required, but unset under convex-test.
  const token: string | undefined = env.POSTHOG_PROJECT_TOKEN;
  return Boolean(token?.trim().startsWith("phc_"));
}

/** PostHog group type for tenants; matches `usePostHogIdentify` in the browser. */
export const COMPANY_GROUP = "company";

/** Distinct id for events no person caused, e.g. a cron or a webhook. */
export function systemDistinctId(tenantId: Id<"tenants">): string {
  return `system:tenant:${tenantId}`;
}

/** `no_show`, `price`. Lowercase words only, so a phone number or a name can't pass. */
const CODED_REASON = /^[a-z][a-z0-9_]{0,63}$/;
/** Single tokens that are still personal data: an email, a phone number, a handle. */
const PERSONAL_TOKEN = /@|^\+?[\d().-]{7,}$/;

function flattenMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  const flattened: Record<string, string | number | boolean | null> = {};
  if (!metadata) return flattened;
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      // Ids, codes, and currencies pass; free text (notes, messages) doesn't.
      if (value.length <= 128 && !/\s/.test(value) && !PERSONAL_TOKEN.test(value)) {
        flattened[`meta_${key}`] = value;
      } else {
        flattened[`meta_${key}_provided`] = value.length > 0;
      }
    } else if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      flattened[`meta_${key}`] = value;
    }
  }
  return flattened;
}

/**
 * Mirror a domain event into PostHog. Called from `emitDomainEvent`, so every
 * business state change (`payment.recorded`, `opportunity.status_changed`, …)
 * becomes a PostHog event attributed to the acting user and grouped by tenant.
 */
export async function captureDomainEvent(
  ctx: MutationCtx,
  params: EmitDomainEventParams,
  domainEventId: Id<"domainEvents">,
  occurredAt: number,
): Promise<void> {
  if (!isServerCaptureEnabled()) return;

  const [tenant, actor]: [Doc<"tenants"> | null, Doc<"users"> | null] =
    await Promise.all([
      ctx.db.get("tenants", params.tenantId),
      params.actorUserId ? ctx.db.get("users", params.actorUserId) : null,
    ]);

  const distinctId = actor?.workosUserId
    ? getRawWorkosUserId(actor.workosUserId)
    : systemDistinctId(params.tenantId);

  await posthog.capture(ctx, {
    distinctId,
    event: params.eventType,
    timestamp: new Date(occurredAt),
    groups: tenant ? { [COMPANY_GROUP]: tenant.workosOrgId } : undefined,
    properties: {
      ...flattenMetadata(params.metadata),
      event_origin: "convex_domain_event",
      domain_event_id: domainEventId,
      tenant_id: params.tenantId,
      entity_type: params.entityType,
      entity_id: params.entityId,
      source: params.source,
      actor_user_id: params.actorUserId,
      actor_role: actor?.role,
      from_status: params.fromStatus,
      to_status: params.toStatus,
      // Coded reasons (`no_show`, `price`) are useful dimensions; free text
      // (a closer's note, an invitee's cancellation message) stays in Convex.
      ...(params.reason && CODED_REASON.test(params.reason)
        ? { reason: params.reason }
        : { has_reason: Boolean(params.reason) }),
      // System events shouldn't create person profiles.
      ...(actor ? {} : { $process_person_profile: false }),
    },
  });
}
