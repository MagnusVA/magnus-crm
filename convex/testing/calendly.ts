"use node";

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { getValidAccessToken } from "../calendly/tokens";

const trackingArgsValidator = v.object({
  utm_campaign: v.optional(v.union(v.string(), v.null())),
  utm_source: v.optional(v.union(v.string(), v.null())),
  utm_medium: v.optional(v.union(v.string(), v.null())),
  utm_content: v.optional(v.union(v.string(), v.null())),
  utm_term: v.optional(v.union(v.string(), v.null())),
  salesforce_uuid: v.optional(v.union(v.string(), v.null())),
});

type CalendlyEventTypeListResponse = {
  collection?: Array<{
    uri?: string;
    name?: string;
    active?: boolean;
    kind?: string;
    pooling_type?: string;
    duration?: number;
    scheduling_url?: string;
  }>;
};

type CalendlyEventTypeDetailsResponse = {
  resource?: {
    uri?: string;
    name?: string;
    active?: boolean;
    kind?: string;
    pooling_type?: string;
    duration?: number;
    scheduling_url?: string;
    custom_questions?: Array<{
      name?: string;
      type?: string;
      position?: number;
      enabled?: boolean;
      required?: boolean;
    }>;
  };
};

type CalendlyAvailableTimesResponse = {
  collection?: Array<{
    status?: string;
    invitees_remaining?: number;
    start_time?: string;
    scheduling_url?: string;
  }>;
};

type CalendlyInviteeResponse = {
  resource?: {
    uri?: string;
    event?: string;
    cancel_url?: string;
    reschedule_url?: string;
    questions_and_answers?: Array<{
      question?: string;
      answer?: string;
      position?: number;
    }>;
  };
};

type EventTypeSummary = {
  uri: string;
  name: string;
  active: boolean;
  kind: string | null;
  poolingType: string | null;
  durationMinutes: number | null;
  schedulingUrl: string | null;
};

type EventTypeQuestion = {
  name: string;
  type: string | null;
  position: number;
  enabled: boolean;
  required: boolean;
};

type AvailableSlot = {
  status: string;
  inviteesRemaining: number;
  startTime: string;
  schedulingUrl: string | null;
};

type TenantCalendlyContext = {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  refreshLockUntil?: number;
  organizationUri?: string;
  userUri?: string;
  tenantStatus: string;
};

type TenantCalendlyAccess = {
  accessToken: string;
  organizationUri: string | null;
  userUri: string | null;
};

function normalizeString(value: string | null | undefined) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNullableString(value: string | null | undefined) {
  return normalizeString(value) ?? null;
}

function parseRequiredFutureIsoString(value: string, fieldName: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a valid ISO8601 timestamp.`);
  }

  return new Date(parsed).toISOString();
}

function buildAvailabilityWindow(args: {
  windowStartIso?: string;
  windowEndIso?: string;
  windowDays?: number;
}) {
  const now = Date.now();
  const startIso = args.windowStartIso
    ? parseRequiredFutureIsoString(args.windowStartIso, "windowStartIso")
    : new Date(now).toISOString();
  const startMs = Date.parse(startIso);

  if (startMs < now - 60_000) {
    throw new Error("windowStartIso must not be in the past.");
  }

  const days = args.windowDays ?? 7;
  if (days < 1 || days > 7) {
    throw new Error("windowDays must be between 1 and 7.");
  }

  const endIso = args.windowEndIso
    ? parseRequiredFutureIsoString(args.windowEndIso, "windowEndIso")
    : new Date(startMs + days * 24 * 60 * 60 * 1000).toISOString();
  const endMs = Date.parse(endIso);

  if (endMs <= startMs) {
    throw new Error("windowEndIso must be after windowStartIso.");
  }

  if (endMs - startMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("Calendly availability windows cannot exceed 7 days.");
  }

  return { startIso, endIso };
}

function extractEventTypeUuid(eventTypeUri: string) {
  const match = eventTypeUri.match(
    /^https:\/\/api\.calendly\.com\/event_types\/([^/?#]+)$/,
  );
  if (!match?.[1]) {
    throw new Error(
      `Invalid Calendly event type URI "${eventTypeUri}". Expected https://api.calendly.com/event_types/<uuid>.`,
    );
  }

  return match[1];
}

function toEventTypeSummary(resource: {
  uri?: string;
  name?: string;
  active?: boolean;
  kind?: string;
  pooling_type?: string;
  duration?: number;
  scheduling_url?: string;
}): EventTypeSummary | null {
  const uri = normalizeString(resource.uri);
  const name = normalizeString(resource.name);
  if (!uri || !name) {
    return null;
  }

  return {
    uri,
    name,
    active: resource.active === true,
    kind: normalizeNullableString(resource.kind),
    poolingType: normalizeNullableString(resource.pooling_type),
    durationMinutes:
      typeof resource.duration === "number" ? resource.duration : null,
    schedulingUrl: normalizeNullableString(resource.scheduling_url),
  };
}

function normalizeQuestion(question: {
  name?: string;
  type?: string;
  position?: number;
  enabled?: boolean;
  required?: boolean;
}): EventTypeQuestion | null {
  const name = normalizeString(question.name);
  if (!name || typeof question.position !== "number") {
    return null;
  }

  return {
    name,
    type: normalizeNullableString(question.type),
    position: question.position,
    enabled: question.enabled !== false,
    required: question.required === true,
  };
}

function normalizeAvailableSlot(slot: {
  status?: string;
  invitees_remaining?: number;
  start_time?: string;
  scheduling_url?: string;
}): AvailableSlot | null {
  const status = normalizeString(slot.status);
  const startTime = normalizeString(slot.start_time);
  if (!status || !startTime) {
    return null;
  }

  return {
    status,
    inviteesRemaining:
      typeof slot.invitees_remaining === "number" ? slot.invitees_remaining : 0,
    startTime,
    schedulingUrl: normalizeNullableString(slot.scheduling_url),
  };
}

async function getTenantCalendlyAccess(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
): Promise<TenantCalendlyAccess> {
  const tenant: TenantCalendlyContext | null = await ctx.runQuery(
    internal.calendly.connectionQueries.getTenantConnectionContext,
    {
      tenantId,
    },
  );

  if (!tenant) {
    throw new Error(`Tenant ${tenantId} not found.`);
  }

  if (
    tenant.tenantStatus !== "active" &&
    tenant.tenantStatus !== "provisioning_webhooks"
  ) {
    throw new Error(
      `Tenant ${tenantId} is not Calendly-ready. Current status: ${tenant.tenantStatus}.`,
    );
  }

  const accessToken = await getValidAccessToken(ctx, tenantId);
  if (!accessToken) {
    throw new Error(
      "Calendly token missing or expired and could not be refreshed. Reconnect Calendly for this tenant.",
    );
  }

  return {
    accessToken,
    organizationUri: tenant.organizationUri ?? null,
    userUri: tenant.userUri ?? null,
  };
}

async function readCalendlyJson<T>(
  response: Response,
  missingScopeMessage: string,
): Promise<T> {
  if (response.status === 403) {
    throw new Error(missingScopeMessage);
  }

  if (!response.ok) {
    throw new Error(
      `Calendly API request failed: ${response.status} ${await response.text()}`,
    );
  }

  return (await response.json()) as T;
}

async function getEventTypeDetails(
  accessToken: string,
  eventTypeUri: string,
): Promise<{
  eventType: EventTypeSummary;
  customQuestions: EventTypeQuestion[];
}> {
  const eventTypeUuid = extractEventTypeUuid(eventTypeUri);
  const response = await fetch(
    `https://api.calendly.com/event_types/${eventTypeUuid}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    },
  );
  const payload = await readCalendlyJson<CalendlyEventTypeDetailsResponse>(
    response,
    "Missing Calendly scope: event_types:read. Reconnect Calendly for this tenant with event type read access.",
  );

  const eventType = payload.resource
    ? toEventTypeSummary(payload.resource)
    : null;
  if (!eventType) {
    throw new Error(
      `Calendly did not return usable event type details for ${eventTypeUri}.`,
    );
  }

  const customQuestions = Array.isArray(payload.resource?.custom_questions)
    ? payload.resource.custom_questions
        .map(normalizeQuestion)
        .filter((question): question is EventTypeQuestion => question !== null)
        .sort((a, b) => a.position - b.position)
    : [];

  return { eventType, customQuestions };
}

async function listAvailableTimes(args: {
  accessToken: string;
  eventTypeUri: string;
  windowStartIso?: string;
  windowEndIso?: string;
  windowDays?: number;
  limit?: number;
}) {
  const { startIso, endIso } = buildAvailabilityWindow(args);
  const params = new URLSearchParams({
    event_type: args.eventTypeUri,
    start_time: startIso,
    end_time: endIso,
  });
  const response = await fetch(
    `https://api.calendly.com/event_type_available_times?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
      },
    },
  );
  const payload = await readCalendlyJson<CalendlyAvailableTimesResponse>(
    response,
    "Missing Calendly scope: availability:read. Reconnect Calendly for this tenant with availability access.",
  );

  const slots = (payload.collection ?? [])
    .map(normalizeAvailableSlot)
    .filter((slot): slot is AvailableSlot => slot !== null)
    .filter(
      (slot) =>
        slot.status === "available" &&
        slot.inviteesRemaining > 0 &&
        Date.parse(slot.startTime) >= Date.parse(startIso),
    )
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));

  return {
    windowStartIso: startIso,
    windowEndIso: endIso,
    slots:
      typeof args.limit === "number" && args.limit > 0
        ? slots.slice(0, args.limit)
        : slots,
  };
}

function buildQuestionsAndAnswers(
  questionAnswers: Record<string, string> | undefined,
  customQuestions: EventTypeQuestion[],
) {
  if (!questionAnswers || Object.keys(questionAnswers).length === 0) {
    return undefined;
  }

  const enabledQuestions = customQuestions.filter((question) => question.enabled);
  const questionsByName = new Map(
    enabledQuestions.map((question) => [question.name, question]),
  );

  const result: Array<{ question: string; answer: string; position: number }> =
    [];

  for (const [questionName, rawAnswer] of Object.entries(questionAnswers)) {
    const question = questionsByName.get(questionName);
    if (!question) {
      throw new Error(
        `Question "${questionName}" is not an enabled custom question for this event type.`,
      );
    }

    const answer = normalizeString(rawAnswer);
    if (!answer) {
      continue;
    }

    result.push({
      question: question.name,
      answer,
      position: question.position,
    });
  }

  return result.length > 0
    ? result.sort((a, b) => a.position - b.position)
    : undefined;
}

function normalizeTracking(
  tracking:
    | {
        utm_campaign?: string | null;
        utm_source?: string | null;
        utm_medium?: string | null;
        utm_content?: string | null;
        utm_term?: string | null;
        salesforce_uuid?: string | null;
      }
    | undefined,
) {
  if (!tracking) {
    return undefined;
  }

  return {
    utm_campaign: normalizeNullableString(tracking.utm_campaign),
    utm_source: normalizeNullableString(tracking.utm_source),
    utm_medium: normalizeNullableString(tracking.utm_medium),
    utm_content: normalizeNullableString(tracking.utm_content),
    utm_term: normalizeNullableString(tracking.utm_term),
    salesforce_uuid: normalizeNullableString(tracking.salesforce_uuid),
  };
}

export const listEventTypes = internalAction({
  args: {
    tenantId: v.id("tenants"),
    activeOnly: v.optional(v.boolean()),
    count: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tenantId: Id<"tenants">;
    organizationUri: string;
    count: number;
    eventTypes: EventTypeSummary[];
  }> => {
    console.log("[Testing:Calendly] listEventTypes", {
      tenantId: args.tenantId,
      activeOnly: args.activeOnly ?? true,
      count: args.count ?? 100,
    });

    const { accessToken, organizationUri } = await getTenantCalendlyAccess(
      ctx,
      args.tenantId,
    );
    if (!organizationUri) {
      throw new Error(
        `Tenant ${args.tenantId} has no stored Calendly organization URI.`,
      );
    }

    const params = new URLSearchParams({
      organization: organizationUri,
      active: String(args.activeOnly ?? true),
      count: String(args.count ?? 100),
      sort: "name:asc",
    });

    const response = await fetch(
      `https://api.calendly.com/event_types?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    const payload = await readCalendlyJson<CalendlyEventTypeListResponse>(
      response,
      "Missing Calendly scope: event_types:read. Reconnect Calendly for this tenant with event type read access.",
    );

    const eventTypes = (payload.collection ?? [])
      .map(toEventTypeSummary)
      .filter((eventType): eventType is EventTypeSummary => eventType !== null);

    return {
      tenantId: args.tenantId,
      organizationUri,
      count: eventTypes.length,
      eventTypes,
    };
  },
});

export const getEventTypeDetailsForTesting = internalAction({
  args: {
    tenantId: v.id("tenants"),
    eventTypeUri: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tenantId: Id<"tenants">;
    eventType: EventTypeSummary;
    customQuestions: EventTypeQuestion[];
  }> => {
    console.log("[Testing:Calendly] getEventTypeDetailsForTesting", {
      tenantId: args.tenantId,
      eventTypeUri: args.eventTypeUri,
    });

    const { accessToken } = await getTenantCalendlyAccess(ctx, args.tenantId);
    const { eventType, customQuestions } = await getEventTypeDetails(
      accessToken,
      args.eventTypeUri,
    );

    return {
      tenantId: args.tenantId,
      eventType,
      customQuestions,
    };
  },
});

export const listAvailableSlots = internalAction({
  args: {
    tenantId: v.id("tenants"),
    eventTypeUri: v.string(),
    windowStartIso: v.optional(v.string()),
    windowEndIso: v.optional(v.string()),
    windowDays: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tenantId: Id<"tenants">;
    eventType: EventTypeSummary;
    customQuestions: EventTypeQuestion[];
    windowStartIso: string;
    windowEndIso: string;
    slotCount: number;
    slots: AvailableSlot[];
  }> => {
    console.log("[Testing:Calendly] listAvailableSlots", {
      tenantId: args.tenantId,
      eventTypeUri: args.eventTypeUri,
    });

    const { accessToken } = await getTenantCalendlyAccess(ctx, args.tenantId);
    const { eventType, customQuestions } = await getEventTypeDetails(
      accessToken,
      args.eventTypeUri,
    );
    const availability = await listAvailableTimes({
      accessToken,
      eventTypeUri: args.eventTypeUri,
      windowStartIso: args.windowStartIso,
      windowEndIso: args.windowEndIso,
      windowDays: args.windowDays,
      limit: args.limit,
    });

    return {
      tenantId: args.tenantId,
      eventType,
      customQuestions,
      windowStartIso: availability.windowStartIso,
      windowEndIso: availability.windowEndIso,
      slotCount: availability.slots.length,
      slots: availability.slots,
    };
  },
});

export const bookTestInvitee = internalAction({
  args: {
    tenantId: v.id("tenants"),
    eventTypeUri: v.string(),
    inviteeEmail: v.string(),
    inviteeName: v.string(),
    inviteeTimezone: v.string(),
    startTimeIso: v.optional(v.string()),
    slotIndex: v.optional(v.number()),
    windowStartIso: v.optional(v.string()),
    windowEndIso: v.optional(v.string()),
    windowDays: v.optional(v.number()),
    textReminderNumber: v.optional(v.string()),
    questionAnswers: v.optional(v.record(v.string(), v.string())),
    tracking: v.optional(trackingArgsValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tenantId: Id<"tenants">;
    eventType: EventTypeSummary;
    customQuestions: EventTypeQuestion[];
    slotWindow:
      | {
          windowStartIso: string;
          windowEndIso: string;
        }
      | null;
    bookedStartTime: string;
    inviteeUri: string;
    eventUri: string;
    cancelUrl: string | null;
    rescheduleUrl: string | null;
    submittedQuestionsAndAnswers: Array<{
      question?: string;
      answer?: string;
      position?: number;
    }>;
  }> => {
    console.log("[Testing:Calendly] bookTestInvitee", {
      tenantId: args.tenantId,
      eventTypeUri: args.eventTypeUri,
      inviteeEmail: args.inviteeEmail,
      hasExplicitStartTime: Boolean(args.startTimeIso),
    });

    const { accessToken } = await getTenantCalendlyAccess(ctx, args.tenantId);
    const { eventType, customQuestions } = await getEventTypeDetails(
      accessToken,
      args.eventTypeUri,
    );

    let selectedStartTime = args.startTimeIso
      ? parseRequiredFutureIsoString(args.startTimeIso, "startTimeIso")
      : null;

    let slotWindow:
      | {
          windowStartIso: string;
          windowEndIso: string;
        }
      | null = null;

    if (!selectedStartTime) {
      const availability = await listAvailableTimes({
        accessToken,
        eventTypeUri: args.eventTypeUri,
        windowStartIso: args.windowStartIso,
        windowEndIso: args.windowEndIso,
        windowDays: args.windowDays,
      });
      const slotIndex = args.slotIndex ?? 0;
      const slot = availability.slots[slotIndex];
      if (!slot) {
        throw new Error(
          `No available Calendly slot found at index ${slotIndex} for ${args.eventTypeUri}.`,
        );
      }

      selectedStartTime = slot.startTime;
      slotWindow = {
        windowStartIso: availability.windowStartIso,
        windowEndIso: availability.windowEndIso,
      };
    }

    const inviteeEmail = normalizeString(args.inviteeEmail);
    const inviteeName = normalizeString(args.inviteeName);
    const inviteeTimezone = normalizeString(args.inviteeTimezone);
    if (!inviteeEmail || !inviteeName || !inviteeTimezone) {
      throw new Error(
        "inviteeEmail, inviteeName, and inviteeTimezone are required.",
      );
    }

    const requestBody = {
      event_type: args.eventTypeUri,
      start_time: selectedStartTime,
      invitee: {
        email: inviteeEmail,
        name: inviteeName,
        timezone: inviteeTimezone,
        text_reminder_number: normalizeString(args.textReminderNumber),
      },
      questions_and_answers: buildQuestionsAndAnswers(
        args.questionAnswers,
        customQuestions,
      ),
      tracking: normalizeTracking(args.tracking),
    };

    const response = await fetch("https://api.calendly.com/invitees", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    const payload = await readCalendlyJson<CalendlyInviteeResponse>(
      response,
      "Missing Calendly scope: scheduled_events:write. Reconnect Calendly for this tenant with scheduling write access.",
    );

    const inviteeUri = normalizeString(payload.resource?.uri);
    const eventUri = normalizeString(payload.resource?.event);
    if (!inviteeUri || !eventUri) {
      throw new Error("Calendly did not return invitee and event URIs.");
    }

    return {
      tenantId: args.tenantId,
      eventType,
      customQuestions,
      slotWindow,
      bookedStartTime: selectedStartTime,
      inviteeUri,
      eventUri,
      cancelUrl: normalizeNullableString(payload.resource?.cancel_url),
      rescheduleUrl: normalizeNullableString(payload.resource?.reschedule_url),
      submittedQuestionsAndAnswers: payload.resource?.questions_and_answers ?? [],
    };
  },
});
