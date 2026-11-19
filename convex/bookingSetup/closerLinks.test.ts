import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingHarness } from "../../tests/bookingHarness";
import { api } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";

const { listCloserLinks, setCloserLink, setCloserLinkInPortal } = api.bookingSetup.closerLinks;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const URL = "https://calendly.com/closer/strategy";
const EVENT_TYPE = "https://api.calendly.com/event_types/strategy";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const { t, tenantId, admin } = await bookingHarness();
  const user = await t.run((ctx) => ctx.db.query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer")).unique());
  if (!user?.calendlyUserUri) throw new Error("Missing fixture closer");
  const userId = user._id;
  const calendar = {
    tenantId,
    displayName: "Strategy Call",
    calendlyEventTypeUri: EVENT_TYPE,
    calendlyOwnerUri: user.calendlyUserUri,
    calendlyKind: "solo",
    calendlyDurationMinutes: 30,
    calendlySyncStatus: "active" as const,
    bookingBaseUrl: URL,
    calendlySchedulingUrl: URL,
    bookingUrlSource: "calendly_synced" as const,
    createdAt: NOW - 60_000,
  };
  const eventTypeConfigId = await t.run((ctx) => ctx.db.insert("eventTypeConfigs", calendar));
  const readUser = () => t.run((ctx) => ctx.db.get("users", userId));
  const readCalendar = () => t.run((ctx) => ctx.db.get("eventTypeConfigs", eventTypeConfigId));
  return { t, tenantId, admin, userId, calendar, eventTypeConfigId, readUser, readCalendar };
}

describe("admin closer links", () => {
  it("lists only active phone closers who have not been removed", async () => {
    const h = await setup();
    await h.t.run(async (ctx) => {
      const closer = {
        tenantId: h.tenantId, role: "closer" as const, isActive: true, closerLinkInPortalAt: NOW,
      };
      await ctx.db.insert("users", {
        ...closer, workosUserId: "user_inactive", email: "inactive@example.com", isActive: false,
      });
      await ctx.db.insert("users", {
        ...closer, workosUserId: "user_deleted", email: "deleted@example.com", deletedAt: NOW,
      });
      await ctx.db.patch("users", h.userId, { fullName: "Phone Closer" });
    });

    const list = await h.admin.query(listCloserLinks, {});
    expect(list.closers).toMatchObject([{
      userId: h.userId,
      name: "Phone Closer",
      status: "needs_link",
      inPortal: false,
      options: [{ eventTypeConfigId: h.eventTypeConfigId, status: "program_from_link_off" }],
    }]);
  });

  it("sets the personal URL and flags the oldest config when choosing a duplicate by ID", async () => {
    const h = await setup();
    const duplicate = await h.t.run((ctx) => ctx.db.insert("eventTypeConfigs", {
      ...h.calendar, createdAt: NOW - 1000,
    }));

    await expect(h.admin.mutation(setCloserLink, { userId: h.userId, eventTypeConfigId: duplicate }))
      .resolves.toMatchObject({ previousPersonalEventTypeUri: null });

    expect(await h.readUser()).toMatchObject({ personalEventTypeUri: URL });
    expect(await h.readCalendar()).toMatchObject({ programFromLinkAt: NOW });
    expect((await h.t.run((ctx) => ctx.db.get("eventTypeConfigs", duplicate)))?.programFromLinkAt)
      .toBeUndefined();
    const list = await h.admin.query(listCloserLinks, {});
    expect(list.closers).toMatchObject([{
      userId: h.userId, status: "ready", linkEventTypeConfigId: h.eventTypeConfigId,
    }]);
  });

  it("matches a pasted URL by case-insensitive host and path and stores the synced URL", async () => {
    const h = await setup();

    await h.admin.mutation(setCloserLink, {
      userId: h.userId, url: "https://CALENDLY.COM/Closer/Strategy/?utm_source=old",
    });

    expect(await h.readUser()).toMatchObject({ personalEventTypeUri: URL });
    expect(await h.readCalendar()).toMatchObject({ programFromLinkAt: NOW });
  });

  it("keeps the previous calendar flagged so links already sent still work", async () => {
    const h = await setup();
    const replacementUrl = "https://calendly.com/closer/replacement";
    const replacement = await h.t.run((ctx) => ctx.db.insert("eventTypeConfigs", {
      ...h.calendar,
      calendlyEventTypeUri: "https://api.calendly.com/event_types/replacement",
      bookingBaseUrl: replacementUrl,
      calendlySchedulingUrl: replacementUrl,
    }));
    await h.admin.mutation(setCloserLink, { userId: h.userId, eventTypeConfigId: h.eventTypeConfigId });
    vi.setSystemTime(NOW + 60_000);

    await expect(h.admin.mutation(setCloserLink, { userId: h.userId, eventTypeConfigId: replacement }))
      .resolves.toMatchObject({ previousPersonalEventTypeUri: URL });

    expect(await h.readUser()).toMatchObject({ personalEventTypeUri: replacementUrl });
    expect(await h.readCalendar()).toMatchObject({ programFromLinkAt: NOW });
    expect(await h.t.run((ctx) => ctx.db.get("eventTypeConfigs", replacement)))
      .toMatchObject({ programFromLinkAt: NOW + 60_000 });
  });

  it("rejects a calendar owned by another closer", async () => {
    const h = await setup();
    await h.t.run(async (ctx) => {
      const calendlyUserUri = "https://api.calendly.com/users/other";
      await ctx.db.insert("users", {
        tenantId: h.tenantId, role: "closer", isActive: true, calendlyUserUri,
        workosUserId: "user_other", email: "other@example.com",
      });
      await ctx.db.patch("eventTypeConfigs", h.eventTypeConfigId, { calendlyOwnerUri: calendlyUserUri });
    });

    await expect(h.admin.mutation(setCloserLink, { userId: h.userId, eventTypeConfigId: h.eventTypeConfigId }))
      .rejects.toMatchObject({ data: { code: "closer_links.not_their_calendar" } });
    expect((await h.readUser())?.personalEventTypeUri).toBeUndefined();
    expect((await h.readCalendar())?.programFromLinkAt).toBeUndefined();
  });

  it.each<{ kind: string; fields: Partial<Doc<"eventTypeConfigs">> }>([
    { kind: "group", fields: { calendlyKind: "group" } },
    { kind: "pooled", fields: { calendlyPoolingType: "round_robin" } },
  ])("rejects a $kind event type", async ({ fields }) => {
    const h = await setup();
    await h.t.run((ctx) => ctx.db.patch("eventTypeConfigs", h.eventTypeConfigId, fields));

    await expect(h.admin.mutation(setCloserLink, { userId: h.userId, eventTypeConfigId: h.eventTypeConfigId }))
      .rejects.toMatchObject({
        data: { code: "closer_links.calendar_unusable", message: "Not a one-on-one event type." },
      });
    expect((await h.readCalendar())?.programFromLinkAt).toBeUndefined();
  });

  it("rejects a calendar assigned to a fixed program", async () => {
    const h = await setup();
    const programId = await h.admin.mutation(api.tenantPrograms.mutations.upsertProgram, { name: "Fixed" });
    await h.t.run((ctx) => ctx.db.patch("eventTypeConfigs", h.eventTypeConfigId, {
      bookingProgramId: programId, bookingProgramName: "Fixed", bookingProgramMappingStatus: "mapped",
    }));

    await expect(h.admin.mutation(setCloserLink, { userId: h.userId, eventTypeConfigId: h.eventTypeConfigId }))
      .rejects.toMatchObject({
        data: { code: "closer_links.calendar_unusable", message: "Event type has a fixed program." },
      });
    expect((await h.readCalendar())?.programFromLinkAt).toBeUndefined();
  });

  it("saves a pasted link that matches no synced event type for follow-ups only", async () => {
    const h = await setup();

    await expect(h.admin.mutation(setCloserLink, {
      userId: h.userId, url: "https://calendly.com/closer/not-in-sync",
    })).resolves.toMatchObject({ status: "not_their_calendar" });
    expect((await h.readUser())?.personalEventTypeUri).toBe("https://calendly.com/closer/not-in-sync");
    expect((await h.readCalendar())?.programFromLinkAt).toBeUndefined();
    await expect(h.admin.mutation(setCloserLinkInPortal, { userId: h.userId, inPortal: true }))
      .rejects.toMatchObject({ data: { code: "closer_links.not_ready" } });
  });

  it("rejects a pasted link that isn't a Calendly link", async () => {
    const h = await setup();

    for (const url of ["https://example.com/closer", "https://notcalendly.com/closer"]) {
      await expect(h.admin.mutation(setCloserLink, { userId: h.userId, url }))
        .rejects.toMatchObject({ data: { code: "closer_links.invalid_url" } });
    }
  });

  it("refuses to pick an event type whose URL another active event type shares", async () => {
    const h = await setup();
    await h.t.run((ctx) => ctx.db.insert("eventTypeConfigs", {
      ...h.calendar, calendlyEventTypeUri: "https://api.calendly.com/event_types/twin",
    }));

    await expect(h.admin.mutation(setCloserLink, { userId: h.userId, eventTypeConfigId: h.eventTypeConfigId }))
      .rejects.toMatchObject({ data: { code: "closer_links.ambiguous" } });
    expect((await h.readCalendar())?.programFromLinkAt).toBeUndefined();
  });

  it("ignores a deleted event type that shares the replacement's URL", async () => {
    const h = await setup();
    await h.t.run((ctx) => ctx.db.insert("eventTypeConfigs", {
      ...h.calendar,
      calendlyEventTypeUri: "https://api.calendly.com/event_types/deleted",
      calendlySyncStatus: "deleted" as const,
      createdAt: NOW - 120_000,
    }));

    await h.admin.mutation(setCloserLink, { userId: h.userId, url: URL });
    const list = await h.admin.query(listCloserLinks, {});
    expect(list.closers).toMatchObject([{ userId: h.userId, status: "ready" }]);
  });

  it("rejects setting a link for an inactive closer", async () => {
    const h = await setup();
    await h.t.run((ctx) => ctx.db.patch("users", h.userId, { isActive: false }));

    await expect(h.admin.mutation(setCloserLink, { userId: h.userId, eventTypeConfigId: h.eventTypeConfigId }))
      .rejects.toMatchObject({ data: { code: "closer_links.deactivated" } });
    expect((await h.readCalendar())?.programFromLinkAt).toBeUndefined();
  });

  it("requires readiness to enable and allows disabling a deactivated closer's link", async () => {
    const h = await setup();
    const setPortal = (inPortal: boolean) => h.admin.mutation(setCloserLinkInPortal, { userId: h.userId, inPortal });

    await expect(setPortal(true)).rejects.toMatchObject({ data: { code: "closer_links.not_ready" } });
    expect((await h.readUser())?.closerLinkInPortalAt).toBeUndefined();

    await h.admin.mutation(setCloserLink, { userId: h.userId, eventTypeConfigId: h.eventTypeConfigId });
    await setPortal(true);
    expect((await h.readUser())?.closerLinkInPortalAt).toBe(NOW);

    await h.t.run((ctx) => ctx.db.patch("users", h.userId, { isActive: false }));
    await setPortal(false);
    expect((await h.readUser())?.closerLinkInPortalAt).toBeUndefined();
    await setPortal(false);
  });
  it("refuses to sort a closer-link calendar into a program, but lets it be set aside", async () => {
    const h = await setup();
    await h.admin.mutation(setCloserLink, { userId: h.userId, eventTypeConfigId: h.eventTypeConfigId });
    const programId = await h.t.run(async (ctx) => {
      const createdByUserId = (await ctx.db.get("users", h.userId))!._id;
      return await ctx.db.insert("tenantPrograms", {
        tenantId: h.tenantId, name: "Accelerator", normalizedName: "accelerator", linkCode: "accelerator",
        createdAt: NOW, createdByUserId, updatedAt: NOW,
      });
    });

    await expect(h.admin.mutation(api.bookingSetup.mutations.sortEventType, {
      eventTypeConfigId: h.eventTypeConfigId,
      sorting: { kind: "program", programId, mode: "normal" },
    })).rejects.toThrow(/closer's calendar/);
    const unchanged = await h.readCalendar();
    expect(unchanged?.bookingProgramId).toBeUndefined();
    expect(unchanged?.programFromLinkAt).toBe(NOW);

    await h.admin.mutation(api.bookingSetup.mutations.sortEventType, {
      eventTypeConfigId: h.eventTypeConfigId,
      sorting: { kind: "not_sales_call" },
    });
    expect((await h.readCalendar())?.notSalesCallAt).toBe(NOW);
    const list = await h.admin.query(listCloserLinks, {});
    expect(list.closers).toMatchObject([{ userId: h.userId, status: "not_sales_call" }]);
  });
});
