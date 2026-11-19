import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { convexTestModules } from "../test.setup";

const CALENDLY = "https://api.calendly.com";
const ORGANIZATION = `${CALENDLY}/organizations/test`;
const HOST = `${CALENDLY}/users/closer`;
const SECOND_HOST = `${CALENDLY}/users/second`;
const ACCESS_TOKEN = "test-access-token";
const mutations = internal.calendly.eventTypeMutations;

type EventType = {
  uri: string;
  name: string;
  scheduling_url: string;
  kind: string;
  pooling_type: string | null;
  active: boolean;
  deleted_at?: string;
};

function roundRobin(slug: string, fields: Partial<EventType> = {}): EventType {
  return {
    uri: `${CALENDLY}/event_types/${slug}`,
    name: slug,
    scheduling_url: `https://calendly.com/test/${slug}`,
    kind: "solo",
    pooling_type: "round_robin",
    active: true,
    ...fields,
  };
}

function membershipPage(eventTypeUri: string, hosts: string[] = [HOST], nextToken?: string) {
  return Response.json({
    collection: hosts.map((uri) => ({ member: { uri }, event_type: { uri: eventTypeUri } })),
    pagination: nextToken === undefined
      ? { next_page: null }
      : { next_page: `${CALENDLY}/event_type_memberships?page_token=${nextToken}`, next_page_token: nextToken },
  });
}

function stubCalendly(options: {
  organization: EventType[];
  users?: Record<string, EventType[]>;
  remaining?: number;
  memberships?: (eventTypeUri: string, pageToken: string | null) => Response;
}) {
  const listingUsers: (string | null)[] = [];
  const membershipReads: [string, string | null][] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe(CALENDLY);
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);

    if (url.pathname === "/event_types" && url.searchParams.get("organization") === ORGANIZATION) {
      const user = url.searchParams.get("user");
      listingUsers.push(user);
      const collection = user === null ? options.organization : options.users?.[user];
      if (!collection) throw new Error(`Unexpected listing for ${user}`);
      const headers = options.remaining === undefined
        ? undefined
        : { "X-RateLimit-Remaining": String(options.remaining) };
      return Response.json({ collection, pagination: { next_page: null } }, { headers });
    }

    const eventTypeUri = url.searchParams.get("event_type");
    if (url.pathname === "/event_type_memberships" && eventTypeUri) {
      const pageToken = url.searchParams.get("page_token");
      membershipReads.push([eventTypeUri, pageToken]);
      if (options.memberships) return options.memberships(eventTypeUri, pageToken);
      if (pageToken !== null) throw new Error(`Unexpected membership page ${pageToken}`);
      return membershipPage(eventTypeUri);
    }

    throw new Error(`Unexpected Calendly request ${url}`);
  });
  return { listingUsers, membershipReads };
}

async function fixture() {
  const t = convexTest(schema, convexTestModules);
  const { tenantId, connectionId } = await t.run(async ({ db }) => {
    const tenantId = await db.insert("tenants", {
      companyName: "Calendly sync test",
      contactEmail: "admin@example.com",
      workosOrgId: "org_calendly_sync",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    const connectionId = await db.insert("tenantCalendlyConnections", {
      tenantId,
      connectionStatus: "connected",
      calendlyOrganizationUri: ORGANIZATION,
      calendlyAccessToken: ACCESS_TOKEN,
      calendlyTokenExpiresAt: Date.now() + 86_400_000,
    });
    return { tenantId, connectionId };
  });

  return {
    t,
    tenantId,
    sync: () => t.action(internal.calendly.eventTypes.syncForTenant, { tenantId }),
    connection: () => t.run(({ db }) => db.get("tenantCalendlyConnections", connectionId)),
    config: (eventType: EventType) => t.run(async ({ db }) => {
      const row = await db.query("eventTypeConfigs")
        .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", eventType.uri))
        .unique();
      if (!row) throw new Error(`Missing config for ${eventType.uri}`);
      return row;
    }),
    addCloserLink: (eventType: EventType) => t.run(({ db }) => db.insert("users", {
      tenantId,
      workosUserId: "user_closer",
      email: "closer@example.com",
      role: "closer",
      isActive: true,
      calendlyUserUri: HOST,
      personalEventTypeUri: eventType.scheduling_url,
    })),
  };
}

function advanceClock() {
  vi.setSystemTime(Date.now() + 1_000);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("syncForTenant host checks", () => {
  it("stores the sole host and clears it when a later sync finds a second host on page two", async () => {
    const f = await fixture();
    const eventType = roundRobin("sales-call");
    const first = stubCalendly({ organization: [eventType] });

    expect(await f.sync()).toMatchObject({ status: "success", hostsChecked: 1, hostsSingle: 1 });
    expect(first.membershipReads).toEqual([[eventType.uri, null]]);
    expect((await f.config(eventType)).calendlySoleHostUri).toBe(HOST);

    advanceClock();
    const second = stubCalendly({
      organization: [eventType],
      memberships: (uri, token) => token === null
        ? membershipPage(uri, [HOST], "next")
        : membershipPage(uri, [SECOND_HOST]),
    });

    expect(await f.sync()).toMatchObject({ status: "success", hostsChecked: 1, hostsSingle: 0, hostsUnverified: 0 });
    expect(second.membershipReads).toEqual([[eventType.uri, null], [eventType.uri, "next"]]);
    expect((await f.config(eventType)).calendlySoleHostUri).toBeUndefined();
  });

  it.each([
    { name: "HTTP 403", response: () => new Response(null, { status: 403 }), reads: 1, unverified: 0 },
    { name: "HTTP 404", response: () => new Response(null, { status: 404 }), reads: 1, unverified: 0 },
    { name: "an empty final page", response: (uri: string) => membershipPage(uri, []), reads: 1, unverified: 0 },
    {
      name: "a one-host page with empty pagination",
      response: () => Response.json({ collection: [{ member: { uri: HOST } }], pagination: {} }),
      reads: 1,
      unverified: 1,
    },
    { name: "two HTTP 500 responses", response: () => new Response(null, { status: 500 }), reads: 2, unverified: 1 },
  ])("clears an existing host on $name and still completes the sync", async ({ response, reads, unverified }) => {
    const f = await fixture();
    const eventType = roundRobin("sales-call");
    stubCalendly({ organization: [eventType] });
    await f.sync();
    expect((await f.config(eventType)).calendlySoleHostUri).toBe(HOST);

    advanceClock();
    const { membershipReads } = stubCalendly({ organization: [eventType], memberships: response });

    expect(await f.sync()).toMatchObject({
      status: "success", hostsChecked: 1, hostsSingle: 0, hostsUnverified: unverified, hostsUnchecked: 0,
    });
    expect(membershipReads).toEqual(Array.from({ length: reads }, () => [eventType.uri, null]));
    expect((await f.config(eventType)).calendlySoleHostUri).toBeUndefined();
    const connection = await f.connection();
    expect(connection?.lastEventTypeSyncStatus).toBe("success");
    expect(connection?.eventTypeSyncLockUntil).toBeUndefined();
  });

  it("stores the sole host after a transient 500", async () => {
    const f = await fixture();
    const eventType = roundRobin("sales-call");
    const reply = vi.fn<(uri: string) => Response>().mockReturnValueOnce(new Response(null, { status: 500 }))
      .mockImplementation((uri) => membershipPage(uri));
    const { membershipReads } = stubCalendly({ organization: [eventType], memberships: reply });

    expect(await f.sync()).toMatchObject({ status: "success", hostsSingle: 1, hostsUnverified: 0 });
    expect(membershipReads).toEqual([[eventType.uri, null], [eventType.uri, null]]);
    expect((await f.config(eventType)).calendlySoleHostUri).toBe(HOST);
  });

  it("skips memberships for one-on-one, group, collective, inactive and deleted event types", async () => {
    const f = await fixture();
    const eventTypes = [
      roundRobin("one-on-one", { pooling_type: null }),
      roundRobin("group", { kind: "group" }),
      roundRobin("collective", { pooling_type: "collective" }),
      roundRobin("inactive", { active: false }),
      roundRobin("deleted", { deleted_at: "2026-11-18T12:00:00Z" }),
    ];
    const { membershipReads } = stubCalendly({ organization: eventTypes });

    expect(await f.sync()).toMatchObject({
      status: "success", totalSeen: 5, hostsChecked: 0, hostsSingle: 0, hostsUnverified: 0, hostsUnchecked: 0,
    });
    expect(membershipReads).toEqual([]);
  });

  it("reads memberships once when the organization and a member both list the same event type", async () => {
    const f = await fixture();
    const eventType = roundRobin("sales-call");
    await f.t.run(({ db }) => db.insert("calendlyOrgMembers", {
      tenantId: f.tenantId, calendlyUserUri: HOST, email: "closer@example.com", lastSyncedAt: Date.now(),
    }));
    const { listingUsers, membershipReads } = stubCalendly({
      organization: [eventType], users: { [HOST]: [eventType] },
    });

    expect(await f.sync()).toMatchObject({ status: "success", totalSeen: 1, hostsChecked: 1, hostsSingle: 1 });
    expect(listingUsers).toEqual([null, HOST]);
    expect(membershipReads).toEqual([[eventType.uri, null]]);
    expect((await f.config(eventType)).calendlySoleHostUri).toBe(HOST);
  });

  it("commits collected host verdicts, skips the missing sweep and releases the lock on HTTP 429", async () => {
    const f = await fixture();
    const confirmed = roundRobin("confirmed");
    const limited = roundRobin("limited");
    const missing = roundRobin("missing");
    stubCalendly({ organization: [limited, missing] });
    expect(await f.sync()).toMatchObject({ status: "success", hostsSingle: 2 });

    advanceClock();
    const { membershipReads } = stubCalendly({
      organization: [confirmed, limited],
      memberships: (uri, token) => {
        if (uri === confirmed.uri) return membershipPage(uri, [SECOND_HOST]);
        if (token === null) return membershipPage(uri, [HOST], "next");
        return new Response(null, { status: 429, headers: { "Retry-After": "10" } });
      },
    });

    await expect(f.sync()).rejects.toThrow("Calendly rate limited event type sync (HTTP 429). Try again in 10 seconds.");
    expect(membershipReads).toHaveLength(3);
    expect(membershipReads).toContainEqual([confirmed.uri, null]);
    expect(membershipReads.at(-1)).toEqual([limited.uri, "next"]);
    expect((await f.config(confirmed)).calendlySoleHostUri).toBe(SECOND_HOST);
    // Asked, and answered 429 before its last page: unproven, so cleared.
    expect((await f.config(limited)).calendlySoleHostUri).toBeUndefined();
    expect(await f.config(missing)).toMatchObject({ calendlySyncStatus: "active", calendlySoleHostUri: HOST });
    const connection = await f.connection();
    expect(connection?.lastEventTypeSyncStatus).toBe("failed");
    expect(connection?.lastEventTypeSyncError).toContain("HTTP 429");
    expect(connection?.eventTypeSyncLockUntil).toBeUndefined();
  });

  it("clears the stored host in the listing patch when a round robin becomes collective", async () => {
    const f = await fixture();
    const eventType = roundRobin("sales-call");
    stubCalendly({ organization: [eventType] });
    await f.sync();
    expect((await f.config(eventType)).calendlySoleHostUri).toBe(HOST);

    advanceClock();
    const { membershipReads } = stubCalendly({
      organization: [{ ...eventType, pooling_type: "collective" }],
    });

    expect(await f.sync()).toMatchObject({ status: "success", hostsChecked: 0 });
    expect(membershipReads).toEqual([]);
    const config = await f.config(eventType);
    expect(config.calendlyPoolingType).toBe("collective");
    expect(config.calendlySoleHostUri).toBeUndefined();
  });

  it("clears the stored host when the listing no longer returns the event type", async () => {
    const f = await fixture();
    const eventType = roundRobin("sales-call");
    stubCalendly({ organization: [eventType] });
    await f.sync();
    expect((await f.config(eventType)).calendlySoleHostUri).toBe(HOST);

    advanceClock();
    const { membershipReads } = stubCalendly({ organization: [] });

    expect(await f.sync()).toMatchObject({ status: "success", notReturned: 1, hostsChecked: 0 });
    expect(membershipReads).toEqual([]);
    const config = await f.config(eventType);
    expect(config.calendlySyncStatus).toBe("not_returned");
    expect(config.calendlyActive).toBe(false);
    expect(config.calendlySoleHostUri).toBeUndefined();
  });

  it("checks the active closer's link first when the listing leaves room for one membership read", async () => {
    const f = await fixture();
    const first = roundRobin("general");
    const second = roundRobin("backup");
    const live = roundRobin("closer-link");
    const organization = [first, second, live];
    await f.addCloserLink(live);
    stubCalendly({ organization });
    expect(await f.sync()).toMatchObject({ status: "success", hostsSingle: 3 });

    advanceClock();
    const { membershipReads } = stubCalendly({
      organization, remaining: 6, memberships: (uri) => membershipPage(uri, [SECOND_HOST]),
    });

    expect(await f.sync()).toMatchObject({
      status: "success", hostsChecked: 1, hostsSingle: 1, hostsUnverified: 0, hostsUnchecked: 2,
    });
    expect(membershipReads).toEqual([[live.uri, null]]);
    expect((await f.config(live)).calendlySoleHostUri).toBe(SECOND_HOST);
    expect((await f.config(first)).calendlySoleHostUri).toBe(HOST);
    expect((await f.config(second)).calendlySoleHostUri).toBe(HOST);
  });

  it("clears an unchecked live link's proof and keeps the unchecked non-live link's proof", async () => {
    const f = await fixture();
    const nonLive = roundRobin("general");
    const live = roundRobin("closer-link");
    const organization = [nonLive, live];
    await f.addCloserLink(live);
    stubCalendly({ organization });
    expect(await f.sync()).toMatchObject({ status: "success", hostsSingle: 2 });
    expect((await f.config(live)).calendlySoleHostUri).toBe(HOST);
    expect((await f.config(nonLive)).calendlySoleHostUri).toBe(HOST);

    advanceClock();
    const { membershipReads } = stubCalendly({ organization, remaining: 5 });

    expect(await f.sync()).toMatchObject({
      status: "success", hostsChecked: 0, hostsSingle: 0, hostsUnverified: 1, hostsUnchecked: 1,
    });
    expect(membershipReads).toEqual([]);
    expect((await f.config(live)).calendlySoleHostUri).toBeUndefined();
    expect((await f.config(nonLive)).calendlySoleHostUri).toBe(HOST);
  });
});

describe("event type sync mutations", () => {
  it("rejects writes and ignores completion with a stale lock token", async () => {
    const f = await fixture();
    const { t, tenantId } = f;
    const eventType = roundRobin("sales-call");
    const verifiedAt = Date.now();
    stubCalendly({ organization: [eventType] });
    await f.sync();
    const before = await f.config(eventType);

    advanceClock();
    const syncStartedAt = Date.now();
    const staleLock = syncStartedAt + 60_000;
    const currentLock = syncStartedAt + 120_000;
    await t.mutation(mutations.acquireEventTypeSyncLock, { tenantId, lockUntil: staleLock });
    await t.mutation(mutations.extendEventTypeSyncLock, {
      tenantId, syncLockUntil: staleLock, minLockUntil: currentLock,
    });
    const connectionBefore = await f.connection();
    expect(connectionBefore?.eventTypeSyncLockUntil).toBe(currentLock);
    const stale = { tenantId, syncLockUntil: staleLock };
    const lockError = "Calendly event type sync lost its lock to a newer sync.";

    await expect(t.mutation(mutations.upsertEventTypesPage, {
      ...stale, syncStartedAt, collection: [{ ...eventType, name: "stale rename" }],
    })).rejects.toThrow(lockError);
    await expect(t.mutation(mutations.recordEventTypeHosts, {
      ...stale, syncStartedAt: verifiedAt, results: [{ eventTypeUri: eventType.uri, soleHostUri: SECOND_HOST }],
    })).rejects.toThrow(lockError);
    await expect(t.mutation(mutations.markMissingEventTypes, { ...stale, syncStartedAt })).rejects.toThrow(lockError);
    await expect(t.mutation(mutations.extendEventTypeSyncLock, {
      ...stale, minLockUntil: currentLock + 60_000,
    })).rejects.toThrow(lockError);
    await t.mutation(mutations.completeEventTypeSync, { ...stale, status: "success" });
    await t.mutation(mutations.completeEventTypeSync, { ...stale, status: "failed", error: "stale failure" });

    expect(await f.config(eventType)).toEqual(before);
    expect(await f.connection()).toEqual(connectionBefore);
  });

  it("ignores a success or failure completion that carries no lock token", async () => {
    const f = await fixture();
    const { t, tenantId } = f;
    stubCalendly({ organization: [roundRobin("sales-call")] });
    await f.sync();
    const connectionBefore = await f.connection();
    expect(connectionBefore?.eventTypeSyncLockUntil).toBeUndefined();

    await t.mutation(mutations.completeEventTypeSync, { tenantId, status: "failed", error: "late failure" });

    expect(await f.connection()).toEqual(connectionBefore);
  });

  it("extends the lock to the larger timestamp and never shortens it", async () => {
    const f = await fixture();
    const { t, tenantId } = f;
    const original = Date.now() + 60_000;
    const extended = original + 60_000;
    await t.mutation(mutations.acquireEventTypeSyncLock, { tenantId, lockUntil: original });

    expect(await t.mutation(mutations.extendEventTypeSyncLock, {
      tenantId, syncLockUntil: original, minLockUntil: extended,
    })).toEqual({ syncLockUntil: extended });
    expect(await t.mutation(mutations.extendEventTypeSyncLock, {
      tenantId, syncLockUntil: extended, minLockUntil: original,
    })).toEqual({ syncLockUntil: extended });
    expect((await f.connection())?.eventTypeSyncLockUntil).toBe(extended);
  });

  it("clears sole-host proof on every verified row and a later sync can restore it", async () => {
    const f = await fixture();
    const organization = [roundRobin("first"), roundRobin("second")];
    stubCalendly({ organization });
    expect(await f.sync()).toMatchObject({ status: "success", hostsSingle: 2 });

    for (const eventType of organization) {
      expect((await f.config(eventType)).calendlySoleHostUri).toBe(HOST);
    }
    const args = { tenantId: f.tenantId };
    expect(await f.t.mutation(mutations.clearSoleHostProof, args)).toEqual({ cleared: 2, done: true });
    for (const eventType of organization) {
      expect((await f.config(eventType)).calendlySoleHostUri).toBeUndefined();
    }
    expect(await f.t.mutation(mutations.clearSoleHostProof, args)).toEqual({ cleared: 0, done: true });

    advanceClock();
    expect(await f.sync()).toMatchObject({ status: "success", hostsSingle: 2 });
    for (const eventType of organization) {
      expect((await f.config(eventType)).calendlySoleHostUri).toBe(HOST);
    }
  });
});
