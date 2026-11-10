import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import {
  registerComponents,
  qualifiedLifecycle,
} from "../../tests/bookingHarness";
import { verifyFathomSignature } from "./webhook";
import { attachRecordingCore } from "./recordings";
import { readTranscriptPage } from "./transcript";

vi.mock("../auth", () => ({ authKit: { registerRoutes: () => {} } }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const secret = `whsec_${btoa("test-secret-with-enough-entropy")}`;
async function signedHeaders(
  body: string,
  id = "message-one",
  stamp = String(Math.floor(Date.now() / 1000)),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test-secret-with-enough-entropy"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${stamp}.${body}`),
    ),
  );
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": stamp,
    "webhook-signature": `v1,${btoa(String.fromCharCode(...bytes))}`,
  });
}
async function fixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  registerComponents(t);
  const ids = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Test",
      contactEmail: "owner@example.com",
      workosOrgId: "org_test",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    const closerId = await ctx.db.insert("users", {
      tenantId,
      email: "closer@example.com",
      workosUserId: "user_closer",
      role: "closer",
      isActive: true,
    });
    const otherId = await ctx.db.insert("users", {
      tenantId,
      email: "other@example.com",
      workosUserId: "user_other",
      role: "closer",
      isActive: true,
    });
    const adminId = await ctx.db.insert("users", {
      tenantId,
      email: "admin@example.com",
      workosUserId: "user_admin",
      role: "tenant_admin",
      isActive: true,
    });
    const connectionId = await ctx.db.insert("tenantFathomConnections", {
      tenantId,
      apiKey: "fake-api-key",
      keyLast4: "-key",
      webhookSecret: secret,
      webhookId: "hook-one",
      connectionStatus: "connected",
      triggeredFor: [],
      connectedByUserId: adminId,
      connectedAt: Date.now(),
    });
    const memberId = await ctx.db.insert("fathomOrgMembers", {
      tenantId,
      email: "closer@example.com",
      matchedUserId: closerId,
      ignored: false,
      lastSyncedAt: Date.now(),
    });
    return { tenantId, closerId, otherId, adminId, connectionId, memberId };
  });
  return {
    t,
    ...ids,
    closer: t.withIdentity({ subject: "user_closer", org_id: "org_test" }),
    admin: t.withIdentity({ subject: "user_admin", org_id: "org_test" }),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function payload(overrides: Record<string, unknown> = {}) {
  return {
    recording_id: 42,
    title: "Sales call",
    meeting_title: "Intro",
    url: "https://fathom.video/calls/42",
    share_url: "https://fathom.video/share/42",
    recorded_by: { email: "closer@example.com" },
    recording_start_time: new Date(Date.now() - 3600_000).toISOString(),
    recording_end_time: new Date(Date.now()).toISOString(),
    scheduled_start_time: new Date(Date.now() - 3600_000).toISOString(),
    scheduled_end_time: new Date(Date.now()).toISOString(),
    calendar_invitees_domains_type: "one_or_more_external",
    calendar_invitees: [{ email: "prospect@example.com", is_external: true }],
    transcript: [
      {
        speaker: {
          display_name: "Closer",
          matched_calendar_invitee_email: "closer@example.com",
        },
        timestamp: "00:00:01",
        text: "Hello",
      },
      {
        speaker: { display_name: "Prospect" },
        timestamp: "00:00:02",
        text: "Hi",
      },
    ],
    default_summary: { markdown_formatted: "Summary" },
    action_items: [
      {
        description: "Send proposal",
        assignee: { email: "closer@example.com" },
        recording_timestamp: "00:01:00",
      },
    ],
    ...overrides,
  };
}
async function ingest(f: Fixture, data = payload(), messageId = "message-one") {
  await f.t.mutation(internal.fathom.processor.ingest, {
    connectionId: f.connectionId,
    webhookMessageId: messageId,
    payload: JSON.stringify(data),
  });
  const event = await f.t.run((ctx) =>
    ctx.db
      .query("fathomWebhookEvents")
      .withIndex("by_tenantId_and_webhookMessageId", (q) =>
        q.eq("tenantId", f.tenantId).eq("webhookMessageId", messageId),
      )
      .unique(),
  );
  if (!event) throw new Error("Missing event");
  await f.t.action(internal.fathom.processor.process, { eventId: event._id });
  return event._id;
}
async function meeting(
  f: Fixture,
  args: {
    at?: number;
    userId?: Id<"users">;
    email?: string;
    joinUrl?: string;
  } = {},
) {
  return f.t.run(async (ctx) => {
    const leadId = await ctx.db.insert("leads", {
      tenantId: f.tenantId,
      status: "active",
      firstSeenAt: Date.now(),
      updatedAt: Date.now(),
      ...qualifiedLifecycle(Date.now()),
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId: f.tenantId,
      leadId,
      assignedCloserId: args.userId ?? f.closerId,
      stage: "booked",
      outcome: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (args.email)
      await ctx.db.insert("leadIdentifiers", {
        tenantId: f.tenantId,
        leadId,
        type: "email",
        value: args.email,
        rawValue: args.email,
        confidence: "verified",
        source: "manual_entry",
        createdAt: Date.now(),
      });
    return ctx.db.insert("meetings", {
      tenantId: f.tenantId,
      opportunityId,
      assignedCloserId: args.userId ?? f.closerId,
      calendlyEventUri: `event-${opportunityId}`,
      calendlyInviteeUri: `invitee-${opportunityId}`,
      scheduledAt: args.at ?? Date.now() - 3600_000,
      durationMinutes: 60,
      status: "scheduled",
      createdAt: Date.now(),
      meetingJoinUrl: args.joinUrl,
    });
  });
}
async function recordings(f: Fixture) {
  return f.t.run((ctx) =>
    ctx.db
      .query("callRecordings")
      .withIndex("by_tenantId_and_fathomRecordingId", (q) =>
        q.eq("tenantId", f.tenantId),
      )
      .take(100),
  );
}

describe("Fathom signatures and ingestion", () => {
  it("verifies the raw body, signature versions, timestamp tolerance and tampering", async () => {
    const body = JSON.stringify(payload());
    const headers = await signedHeaders(body);
    expect(await verifyFathomSignature(secret, headers, body)).toBe(true);
    headers.set(
      "webhook-signature",
      `v2,garbage v1,%%% ${headers.get("webhook-signature")}`,
    );
    expect(await verifyFathomSignature(secret, headers, body)).toBe(true);
    expect(await verifyFathomSignature(secret, headers, `${body} `)).toBe(
      false,
    );
    expect(
      await verifyFathomSignature(
        secret,
        await signedHeaders(
          body,
          "old",
          String(Math.floor(Date.now() / 1000) - 301),
        ),
        body,
      ),
    ).toBe(false);
    expect(
      await verifyFathomSignature(
        secret,
        await signedHeaders(
          body,
          "future",
          String(Math.floor(Date.now() / 1000) + 301),
        ),
        body,
      ),
    ).toBe(false);
    headers.set("webhook-timestamp", "garbage");
    expect(await verifyFathomSignature(secret, headers, body)).toBe(false);
  });
  it("accepts signed HTTP deliveries and dedupes webhook-id before processing", async () => {
    const f = await fixture(),
      body = JSON.stringify(payload());
    const headers = await signedHeaders(body);
    const url = `/webhooks/fathom?c=${f.connectionId}`;
    expect(
      (await f.t.fetch(url, { method: "POST", headers, body })).status,
    ).toBe(200);
    expect(
      (await f.t.fetch(url, { method: "POST", headers, body })).status,
    ).toBe(200);
    expect(
      (await f.t.fetch(url, { method: "POST", headers, body: "tampered" }))
        .status,
    ).toBe(401);
    const rows = await f.t.run((ctx) =>
      ctx.db.query("fathomWebhookEvents").take(5),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].payloadStorageId).toBeDefined();
  });
  it.each(["ignored", "internal"])(
    "discards %s payloads, retains only a count and receipt",
    async (kind) => {
      const f = await fixture();
      if (kind === "ignored")
        await f.t.run((ctx) =>
          ctx.db.patch("fathomOrgMembers", f.memberId, { ignored: true }),
        );
      const eventId = await ingest(
        f,
        kind === "internal"
          ? payload({
              calendar_invitees_domains_type: "only_internal",
              calendar_invitees: [
                { email: "closer@example.com", is_external: false },
              ],
            })
          : payload(),
      );
      expect(await recordings(f)).toHaveLength(0);
      expect(
        await f.t.run((ctx) => ctx.db.get("fathomWebhookEvents", eventId)),
      ).toMatchObject({ status: "dropped", payload: "" });
      expect(
        await f.t.run((ctx) =>
          ctx.db.get("tenantFathomConnections", f.connectionId),
        ),
      ).toMatchObject({ droppedCount: 1 });
    },
  );
  it("holds unlinked payloads and processes them when an admin links the member", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch("fathomOrgMembers", f.memberId, {
        matchedUserId: undefined,
      }),
    );
    const id = await ingest(f);
    expect(
      await f.t.run((ctx) => ctx.db.get("fathomWebhookEvents", id)),
    ).toMatchObject({ status: "held", holdUntil: Date.now() + 7 * 86400_000 });
    await f.admin.mutation(api.fathom.connection.linkMember, {
      memberId: f.memberId,
      userId: f.closerId,
    });
    await f.t.action(internal.fathom.processor.process, { eventId: id });
    expect(await recordings(f)).toHaveLength(1);
  });
});
describe("Fathom matching", () => {
  it("matches one candidate by time, emits once and leaves meeting attendance unchanged", async () => {
    const f = await fixture(),
      meetingId = await meeting(f);
    await ingest(f);
    await ingest(f, payload(), "message-two");
    const rows = await recordings(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      meetingId,
      matchMethod: "time_only",
      matchStatus: "matched",
    });
    const m = await f.t.run((ctx) => ctx.db.get("meetings", meetingId));
    expect(m?.status).toBe("scheduled");
    expect(m?.heldMarkedAt).toBeUndefined();
    const events = await f.t.run((ctx) =>
      ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
          q
            .eq("tenantId", f.tenantId)
            .eq("eventType", "meeting.recording_matched"),
        )
        .take(10),
    );
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("system");
    expect(
      await f.closer.query(api.fathom.recordings.forMeeting, { meetingId }),
    ).toMatchObject({
      summary: "Summary",
      minutes: 60,
      transcriptPageCount: 1,
    });
    const transcript = await f.t.run((ctx) =>
      readTranscriptPage(ctx, rows[0]._id, 2, 1),
    );
    expect(transcript).toMatchObject({
      page: 2,
      pageCount: 2,
      lines: [{ speaker: "Prospect", text: "Hi" }],
    });
  });
  it.each(["email", "url", "tie", "none", "placeholder", "invalid_url"])(
    "handles several candidates or none: %s",
    async (mode) => {
      const f = await fixture();
      let expected;
      if (mode !== "none") {
        expected = await meeting(f, {
          email:
            mode === "placeholder" ? "email@gmail.com" : "prospect@example.com",
          joinUrl: "https://zoom.us/j/123",
        });
        await meeting(f, {
          email: mode === "tie" ? "prospect@example.com" : undefined,
        });
      }
      await ingest(
        f,
        payload({
          calendar_invitees: [
            {
              email:
                mode === "placeholder"
                  ? "email@gmail.com"
                  : mode === "url" || mode === "invalid_url"
                    ? "unknown@example.com"
                    : "prospect@example.com",
              is_external: true,
            },
          ],
          meeting_url:
            mode === "url"
              ? "https://zoom.us/j/123?pwd=secret"
              : mode === "invalid_url"
                ? "invalid"
                : null,
        }),
      );
      const [row] = await recordings(f);
      if (mode === "email" || mode === "url")
        expect(row).toMatchObject({
          meetingId: expected,
          matchMethod: `time_${mode}`,
        });
      else expect(row.matchStatus).toBe("unmatched");
    },
  );
});
describe("Fathom assignment and retention", () => {
  it("enforces closer ownership and lets admins reassign, without recording attendance", async () => {
    const f = await fixture();
    await ingest(f);
    const [recording] = await recordings(f);
    const own = await meeting(f),
      other = await meeting(f, { userId: f.otherId });
    const actor = {
      tenantId: f.tenantId,
      userId: f.closerId,
      role: "closer" as const,
    };
    await expect(
      f.t.run((ctx) =>
        attachRecordingCore(ctx, actor, {
          recordingId: recording._id,
          meetingId: other,
        }),
      ),
    ).rejects.toThrow("cannot access");
    await expect(
      f.t.run((ctx) =>
        attachRecordingCore(
          ctx,
          { ...actor, userId: f.otherId },
          { recordingId: recording._id, notASalesCall: true },
        ),
      ),
    ).rejects.toThrow("cannot assign");
    await f.t.run((ctx) =>
      attachRecordingCore(ctx, actor, {
        recordingId: recording._id,
        meetingId: own,
      }),
    );
    await expect(
      f.t.run((ctx) =>
        attachRecordingCore(ctx, actor, {
          recordingId: recording._id,
          notASalesCall: true,
        }),
      ),
    ).rejects.toThrow("cannot assign");
    await f.admin.mutation(api.fathom.recordings.attach, {
      recordingId: recording._id,
      meetingId: other,
    });
    expect((await recordings(f))[0]).toMatchObject({
      meetingId: other,
      matchedByUserId: f.adminId,
      matchMethod: "manual",
    });
    expect(
      (await f.t.run((ctx) => ctx.db.get("meetings", other)))?.heldMarkedAt,
    ).toBeUndefined();
  });
  it("lets the closer mark their unmatched recording Not a sales call", async () => {
    const f = await fixture();
    await ingest(f);
    const [r] = await recordings(f);
    await f.closer.mutation(api.fathom.recordings.attach, {
      recordingId: r._id,
      notASalesCall: true,
    });
    expect((await recordings(f))[0].matchStatus).toBe("ignored");
    expect(
      (await f.closer.query(api.fathom.recordings.unmatched, {})).recordings,
    ).toHaveLength(0);
  });
  it("purges raw events and expired transcripts, preserving summaries", async () => {
    const f = await fixture();
    await ingest(f);
    const [r] = await recordings(f);
    const storageId = r.transcriptStorageId!;
    vi.setSystemTime(Date.now() + 91 * 86400_000);
    await f.t.mutation(internal.fathom.maintenance.purge, {});
    const [row] = await recordings(f);
    expect(row.summaryMarkdown).toBe("Summary");
    expect(row.transcriptStorageId).toBeUndefined();
    expect(row.transcriptDeletedAt).toBe(Date.now());
    expect(await f.t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
    expect(
      await f.t.run((ctx) => ctx.db.query("fathomWebhookEvents").take(1)),
    ).toHaveLength(0);
  });
  it("expires held payloads at seven days without importing a recording", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch("fathomOrgMembers", f.memberId, {
        matchedUserId: undefined,
      }),
    );
    const eventId = await ingest(f);
    vi.setSystemTime(Date.now() + 7 * 86400_000);
    await f.t.mutation(internal.fathom.maintenance.purge, {});
    expect(
      await f.t.run((ctx) => ctx.db.get("fathomWebhookEvents", eventId)),
    ).toBeNull();
    expect(await recordings(f)).toHaveLength(0);
  });
  it("does not expose credentials in settings and denies closer settings access", async () => {
    const f = await fixture();
    const settings = await f.admin.query(api.fathom.connection.settings, {});
    expect(JSON.stringify(settings)).not.toContain("fake-api-key");
    expect(JSON.stringify(settings)).not.toContain(secret);
    await expect(
      f.closer.query(api.fathom.connection.settings, {}),
    ).rejects.toThrow("permissions");
  });
});

describe("Fathom API workflows", () => {
  it("connects with a dedicated seat, enables every include flag and hides the webhook secret", async () => {
    const f = await fixture();
    vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        vi.setSystemTime(Date.now() + 3000);
        if (url.endsWith("/team_members"))
          return Response.json({
            items: [{ email: "closer@example.com", name: "Closer" }],
            next_cursor: null,
          });
        if (url.endsWith("/users")) return new Response(null, { status: 403 });
        if (url.endsWith("/webhooks"))
          return Response.json({ id: "new-hook", secret }, { status: 201 });
        throw new Error("Unexpected stub request");
      }),
    );
    await f.admin.action(api.fathom.connection.connect, {
      apiKey: "new-fake-api-key",
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("https://api.fathom.ai/external/v1/team_members");
    expect(calls[0].init?.headers).toMatchObject({
      "X-Api-Key": "new-fake-api-key",
    });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      destination_url: `https://test.convex.site/webhooks/fathom?c=${f.connectionId}`,
      triggered_for: [
        "my_recordings",
        "my_shared_with_team_recordings",
        "shared_team_recordings",
      ],
      include_transcript: true,
      include_summary: true,
      include_action_items: true,
      include_crm_matches: true,
    });
    const settings = await f.admin.query(api.fathom.connection.settings, {});
    expect(settings.connection).toMatchObject({
      status: "connected",
      keyLast4: "-key",
      accountAdmin: false,
    });
    expect(JSON.stringify(settings)).not.toContain(secret);
  });
  it("disconnect deletes the vendor webhook and clears credentials", async () => {
    const f = await fixture();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await f.admin.action(api.fathom.connection.disconnect, {});
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.fathom.ai/external/v1/webhooks/hook-one",
      expect.objectContaining({ method: "DELETE" }),
    );
    const c = await f.t.run((ctx) =>
      ctx.db.get("tenantFathomConnections", f.connectionId),
    );
    expect(c).toMatchObject({ connectionStatus: "disconnected", apiKey: "" });
    expect(c?.webhookSecret).toBeUndefined();
  });
  it("fetches the summary and transcript a list item left out through recording endpoints", async () => {
    const f = await fixture();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        vi.setSystemTime(Date.now() + 3000);
        if (url.includes("/meetings?"))
          return Response.json({
            items: [
              payload({
                transcript: undefined,
                default_summary: undefined,
                action_items: undefined,
              }),
            ],
            next_cursor: null,
          });
        if (url.endsWith("/summary"))
          return Response.json({
            summary: { markdown_formatted: "Fetched summary" },
          });
        if (url.endsWith("/transcript"))
          return Response.json({ transcript: payload().transcript });
        throw new Error("Unexpected stub request");
      }),
    );
    const startedAt = Date.now();
    await f.t.mutation(internal.fathom.maintenance.startReconcile, {
      connectionId: f.connectionId,
      since: startedAt - 30 * 86400_000,
    });
    const c = await f.t.run((ctx) =>
      ctx.db.get("tenantFathomConnections", f.connectionId),
    );
    await f.t.action(internal.fathom.maintenance.reconcile, {
      connectionId: f.connectionId,
      token: c!.reconcileToken!,
      since: startedAt - 30 * 86400_000,
      startedAt,
      memberCursor: null,
      apiCursor: null,
      emails: [],
      attempt: 0,
    });
    const event = await f.t.run((ctx) =>
      ctx.db.query("fathomWebhookEvents").take(1),
    );
    await f.t.action(internal.fathom.processor.process, {
      eventId: event[0]._id,
    });
    expect((await recordings(f))[0]).toMatchObject({
      summaryMarkdown: "Fetched summary",
      transcriptLineCount: 2,
    });
    const params = new URL(calls[0]).searchParams;
    expect(params.getAll("recorded_by[]")).toEqual(["closer@example.com"]);
    expect(params.has("created_after")).toBe(true);
    expect(params.get("include_transcript")).toBe("true");
    expect(params.get("include_summary")).toBe("true");
    expect(params.get("include_action_items")).toBe("true");
    expect(calls[1]).toMatch(/\/recordings\/42\/summary$/);
    expect(calls[2]).toMatch(/\/recordings\/42\/transcript$/);
  });
  it("stores a recording that Fathom didn't summarize or transcribe", async () => {
    const f = await fixture();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        vi.setSystemTime(Date.now() + 3000);
        if (url.includes("/meetings?"))
          return Response.json({
            items: [payload({ transcript: null, default_summary: undefined })],
            next_cursor: null,
          });
        if (url.endsWith("/summary")) return Response.json({ summary: null });
        if (url.endsWith("/transcript"))
          return Response.json({ transcript: null });
        throw new Error("Unexpected stub request");
      }),
    );
    const startedAt = Date.now();
    await f.t.mutation(internal.fathom.maintenance.startReconcile, {
      connectionId: f.connectionId,
      since: startedAt - 30 * 86400_000,
    });
    const c = await f.t.run((ctx) =>
      ctx.db.get("tenantFathomConnections", f.connectionId),
    );
    await f.t.action(internal.fathom.maintenance.reconcile, {
      connectionId: f.connectionId,
      token: c!.reconcileToken!,
      since: startedAt - 30 * 86400_000,
      startedAt,
      memberCursor: null,
      apiCursor: null,
      emails: [],
      attempt: 0,
    });
    const event = await f.t.run((ctx) =>
      ctx.db.query("fathomWebhookEvents").take(1),
    );
    await f.t.action(internal.fathom.processor.process, {
      eventId: event[0]._id,
    });
    const [recording] = await recordings(f);
    expect(recording).toMatchObject({ transcriptLineCount: 0 });
    expect(recording.summaryMarkdown).toBeUndefined();
    const processed = await f.t.run((ctx) =>
      ctx.db.get("fathomWebhookEvents", event[0]._id),
    );
    expect(processed?.status).toBe("processed");
    expect(calls[1]).toMatch(/\/recordings\/42\/summary$/);
    expect(calls[2]).toMatch(/\/recordings\/42\/transcript$/);
  });
  it("stores recordings from the list alone, with no request per recording", async () => {
    const f = await fixture();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        vi.setSystemTime(Date.now() + 3000);
        if (url.includes("/meetings?"))
          return Response.json({
            // The second recording has no summary or speech: null and [] are answers, not gaps.
            items: [
              payload(),
              payload({ recording_id: 43, default_summary: null, transcript: [] }),
            ],
            next_cursor: null,
          });
        throw new Error("Unexpected stub request");
      }),
    );
    const startedAt = Date.now();
    await f.t.mutation(internal.fathom.maintenance.startReconcile, {
      connectionId: f.connectionId,
      since: startedAt - 30 * 86400_000,
    });
    const c = await f.t.run((ctx) =>
      ctx.db.get("tenantFathomConnections", f.connectionId),
    );
    await f.t.action(internal.fathom.maintenance.reconcile, {
      connectionId: f.connectionId,
      token: c!.reconcileToken!,
      since: startedAt - 30 * 86400_000,
      startedAt,
      memberCursor: null,
      apiCursor: null,
      emails: [],
      attempt: 0,
    });
    const events = await f.t.run((ctx) =>
      ctx.db.query("fathomWebhookEvents").take(10),
    );
    for (const event of events)
      await f.t.action(internal.fathom.processor.process, {
        eventId: event._id,
      });
    const stored = await recordings(f);
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r.fathomRecordingId === 42)).toMatchObject({
      summaryMarkdown: "Summary",
      transcriptLineCount: 2,
      actionItems: [
        {
          description: "Send proposal",
          assigneeEmail: "closer@example.com",
          timestamp: "00:01:00",
        },
      ],
    });
    const silent = stored.find((r) => r.fathomRecordingId === 43);
    expect(silent?.summaryMarkdown).toBeUndefined();
    expect(silent?.transcriptLineCount).toBe(0);
    expect(calls).toHaveLength(1);
  });
  it("serializes API request reservations and honors a 429 Retry-After", async () => {
    const f = await fixture(),
      now = Date.now();
    const slots = await Promise.all(
      Array.from({ length: 30 }, () =>
        f.t.mutation(internal.fathom.state.reserveRequest, {
          connectionId: f.connectionId,
        }),
      ),
    );
    expect(new Set(slots).size).toBeGreaterThan(20);
    expect(Math.max(...slots) - now).toBeGreaterThanOrEqual(46_200);
    await f.t.run((ctx) =>
      ctx.db.patch("tenantFathomConnections", f.connectionId, {
        nextRequestAt: undefined,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "Retry-After": "120" },
          }),
      ),
    );
    await f.t.action(internal.fathom.maintenance.syncRoster, {
      connectionId: f.connectionId,
      kind: "team_members",
      cursor: null,
    });
    expect(
      (
        await f.t.run((ctx) =>
          ctx.db.get("tenantFathomConnections", f.connectionId),
        )
      )?.nextRequestAt,
    ).toBe(now + 120_000);
  });
});

it("denies cross-tenant assignment even to an admin", async () => {
  const f = await fixture();
  await ingest(f);
  const [recording] = await recordings(f);
  const foreignTenantId = await f.t.run((ctx) =>
    ctx.db.insert("tenants", {
      companyName: "Other",
      contactEmail: "other@example.com",
      workosOrgId: "org_other",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    }),
  );
  await expect(
    f.t.run((ctx) =>
      attachRecordingCore(
        ctx,
        { tenantId: foreignTenantId, userId: f.adminId, role: "tenant_admin" },
        { recordingId: recording._id, notASalesCall: true },
      ),
    ),
  ).rejects.toThrow("cannot assign");
});

it.each(["reset", "tenant"] as const)(
  "deletes raw payload files during %s cleanup",
  async (kind) => {
    const f = await fixture();
    const storageId = await f.t.run((ctx) =>
      ctx.storage.store(
        new Blob([JSON.stringify(payload())], { type: "application/json" }),
      ),
    );
    await f.t.mutation(internal.fathom.processor.ingest, {
      connectionId: f.connectionId,
      webhookMessageId: "cleanup",
      payloadStorageId: storageId,
    });
    if (kind === "reset")
      await f.t.mutation(
        internal.testing.operationalData.deleteOperationalDataBatch,
        { tableName: "fathomWebhookEvents" },
      );
    else {
      // Tenant teardown walks its table list in bounded batches.
      for (let i = 0; i < 30; i++) {
        await f.t.mutation(
          internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch,
          { tenantId: f.tenantId },
        );
        if (!(await f.t.run((ctx) => ctx.storage.get(storageId)))) break;
      }
    }
    expect(await f.t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
  },
);
