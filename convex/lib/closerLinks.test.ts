import { describe, expect, it, vi } from "vitest";
import {
  bookingUrlKey,
  buildCloserLinkUrl,
  calendarHolderUri,
  calendarStatus,
  type CloserCalendarConfig,
  closerLinkStatus,
  type CloserLinkStatus,
  isLinkCode,
  normalizeLinkCode,
  pickUniqueLinkCode,
  readsProgramFromLink,
  sameBookingUrl,
  slugifyLinkCode,
} from "./closerLinks";

describe("program link codes", () => {
  it.each(["a", "7", "25k-accelerator", "a".repeat(24)])("accepts %j", (code) => {
    expect(isLinkCode(code)).toBe(true);
  });

  it.each(["", "ABC", "-abc", "abc-", "a_b", "a b", "café", "a".repeat(25)])(
    "rejects %j",
    (code) => expect(isLinkCode(code)).toBe(false),
  );

  it("normalizes manual input without slugifying it", () => {
    expect(normalizeLinkCode("  COACH-2\n")).toBe("coach-2");
    expect(normalizeLinkCode("  Élite + VIP  ")).toBe("élite + vip");
  });

  it.each([
    ["  25K Accelerator!  ", "25k-accelerator"],
    ["Élite déjà vu ＶＩＰ", "elite-deja-vu-vip"],
    ["abc日本語def", "abc-def"],
    ["日本語", "program"],
    [" ", "program"],
    ["", "program"],
    ["abcdefghijklmnopqrstuvw long", "abcdefghijklmnopqrstuvw"],
    ["abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwx"],
  ])("slugifies %j as %j", (name, code) => {
    expect(slugifyLinkCode(name)).toBe(code);
  });

  it("keeps a free base and tries suffixes in order when occupied", () => {
    expect(pickUniqueLinkCode("vip", new Set(["vip-2"]))).toBe("vip");
    expect(pickUniqueLinkCode("vip", new Set(["vip"]))).toBe("vip-2");
    expect(pickUniqueLinkCode("vip", new Set(["vip", "vip-2", "vip-4"]))).toBe("vip-3");
  });

  it("shortens a 24-character base for two-digit suffixes", () => {
    const base = "abcdefghijklmnopqrstuvwx";
    const taken = new Set([base, ...Array.from({ length: 8 }, (_, i) => `abcdefghijklmnopqrstuv-${i + 2}`)]);
    const code = pickUniqueLinkCode(base, taken);

    expect(code).toBe("abcdefghijklmnopqrstu-10");
    expect(code).toHaveLength(24);
    expect(isLinkCode(code)).toBe(true);
  });

  it("drops the dash at the end of a truncated base before adding a suffix", () => {
    const base = "abcdefghijklmnopqrstu-ab";
    expect(pickUniqueLinkCode(base, new Set([base]))).toBe("abcdefghijklmnopqrstu-2");
  });
});

describe("Calendly link URLs", () => {
  it("compares host and path without case, query, fragment, or trailing slashes", () => {
    const pasted = " HTTPS://Calendly.com/Closer/Sales///?utm_content=old#info ";
    const synced = "https://calendly.com/closer/sales";

    expect(bookingUrlKey(pasted)).toBe("calendly.com/closer/sales");
    expect(sameBookingUrl(pasted, synced)).toBe(true);
    expect(sameBookingUrl(synced, "https://calendly.com/closer/other")).toBe(false);
    expect(sameBookingUrl(synced, "https://other.example/closer/sales")).toBe(false);
  });

  it.each([undefined, "", "calendly.com/closer/sales", "not a URL", "ftp://calendly.com/closer/sales"])(
    "rejects %j as a booking URL",
    (url) => {
      expect(bookingUrlKey(url)).toBeNull();
      expect(sameBookingUrl(url, url)).toBe(false);
      expect(sameBookingUrl("https://calendly.com/closer/sales", url)).toBe(false);
    },
  );

  it("replaces all four UTMs and preserves unrelated query values and the fragment", () => {
    const url = new URL(buildCloserLinkUrl({
      calendarUrl: "https://calendly.com/closer/sales?hide_gdpr_banner=1&tag=a&tag=b&utm_term=keep&utm_source=old&utm_source=duplicate&utm_medium=old&utm_campaign=old&utm_content=old#about",
      teamUtmSource: "Team A",
      dmCloserUtmMedium: "Setter + Partners",
      utmCampaign: "Winter / VIP",
      programLinkCode: "vip-2",
    }));

    expect(url.origin + url.pathname).toBe("https://calendly.com/closer/sales");
    expect(url.hash).toBe("#about");
    expect(url.searchParams.get("hide_gdpr_banner")).toBe("1");
    expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
    expect(url.searchParams.get("utm_term")).toBe("keep");
    expect(url.searchParams.getAll("utm_source")).toEqual(["Team A"]);
    expect(url.searchParams.getAll("utm_medium")).toEqual(["Setter + Partners"]);
    expect(url.searchParams.getAll("utm_campaign")).toEqual(["Winter / VIP"]);
    expect(url.searchParams.getAll("utm_content")).toEqual(["vip-2"]);
  });
});

const CLOSER_URI = "https://api.calendly.com/users/closer";
const OTHER_USER_URI = "https://api.calendly.com/users/other";

const calendar: CloserCalendarConfig = {
  _id: "calendar",
  createdAt: 0,
  calendlyEventTypeUri: "https://api.calendly.com/event_types/sales",
  calendlyOwnerUri: CLOSER_URI,
  calendlyKind: "solo",
  calendlySyncStatus: "active",
  bookingBaseUrl: "https://calendly.com/closer/sales",
  programFromLinkAt: 0,
};
const closer: Parameters<typeof closerLinkStatus>[0] = {
  role: "closer",
  isActive: true,
  calendlyUserUri: CLOSER_URI,
  personalEventTypeUri: "https://calendly.com/Closer/Sales/",
};

const hostedRoundRobin = {
  ...calendar,
  calendlyOwnerUri: OTHER_USER_URI,
  calendlyPoolingType: "round_robin",
  calendlySoleHostUri: CLOSER_URI,
};

describe("calendar holder", () => {
  it.each([
    { name: "one-on-one", config: calendar, holder: CLOSER_URI },
    { name: "legacy one-on-one without a kind", config: { ...calendar, calendlyKind: undefined }, holder: CLOSER_URI },
    { name: "round robin hosted by the closer", config: hostedRoundRobin, holder: CLOSER_URI },
    {
      name: "round robin without a sole host",
      config: { ...hostedRoundRobin, calendlySoleHostUri: undefined },
      holder: undefined,
    },
    {
      name: "round robin hosted by another user",
      config: { ...hostedRoundRobin, calendlySoleHostUri: OTHER_USER_URI },
      holder: OTHER_USER_URI,
    },
    {
      name: "round robin owned by the closer and hosted by another user",
      config: { ...hostedRoundRobin, calendlyOwnerUri: CLOSER_URI, calendlySoleHostUri: OTHER_USER_URI },
      holder: OTHER_USER_URI,
    },
    { name: "collective", config: { ...hostedRoundRobin, calendlyPoolingType: "collective" }, holder: undefined },
    { name: "multi-pool", config: { ...hostedRoundRobin, calendlyPoolingType: "multi_pool" }, holder: undefined },
    { name: "group", config: { ...hostedRoundRobin, calendlyKind: "group" }, holder: undefined },
  ])("resolves the holder for $name", ({ config, holder }) => {
    expect(calendarHolderUri(config)).toBe(holder);
  });
});

describe("closer link status", () => {
  it.each<[Partial<typeof closer>, CloserLinkStatus]>([
    [{ isActive: false }, "deactivated"],
    [{ deletedAt: 0 }, "deactivated"],
    [{ role: "tenant_admin" }, "not_closer"],
    [{ calendlyUserUri: undefined }, "calendly_not_linked"],
    [{ personalEventTypeUri: undefined }, "needs_link"],
  ])("checks user fields %j before matching a calendar", (fields, status) => {
    const canonical = vi.fn(() => calendar);

    expect(closerLinkStatus({ ...closer, ...fields }, [calendar], canonical)).toEqual({
      status,
      config: null,
    });
    expect(canonical).not.toHaveBeenCalled();
  });

  it("rejects a matching URL on an event type owned by someone else", () => {
    expect(closerLinkStatus(closer, [{ ...calendar, calendlyOwnerUri: "someone-else" }], () => calendar))
      .toEqual({ status: "not_their_calendar", config: null });
  });

  it("rejects a URL that matches more than one event type", () => {
    const other = { ...calendar, _id: "other", calendlyEventTypeUri: "other-event-type" };
    const canonical = vi.fn(() => calendar);

    expect(closerLinkStatus(closer, [calendar, other], canonical)).toEqual({
      status: "ambiguous",
      config: null,
    });
    expect(canonical).not.toHaveBeenCalled();
  });

  it("rejects a match when there is no canonical config", () => {
    expect(closerLinkStatus(closer, [calendar], () => null)).toEqual({
      status: "not_their_calendar",
      config: null,
    });
  });

  it("is Ready when the closer is the sole host of a flagged round robin", () => {
    expect(closerLinkStatus(closer, [hostedRoundRobin], () => hostedRoundRobin)).toEqual({
      status: "ready",
      config: hostedRoundRobin,
    });
  });

  it("rejects a hosted round robin when its canonical row lacks the host", () => {
    const canonical = { ...hostedRoundRobin, calendlySoleHostUri: undefined };
    const newer = { ...hostedRoundRobin, _id: "newer", createdAt: 1 };

    expect(closerLinkStatus<CloserCalendarConfig>(closer, [newer], () => canonical)).toEqual({
      status: "not_their_calendar",
      config: null,
    });
  });

  it("treats matching duplicate rows as one event type and uses its canonical config", () => {
    const newer = { ...calendar, _id: "newer", createdAt: 1 };
    const canonical = { ...calendar, programFromLinkAt: undefined };
    const getCanonical = vi.fn(() => canonical);

    expect(closerLinkStatus(closer, [newer, calendar], getCanonical)).toEqual({
      status: "program_from_link_off",
      config: canonical,
    });
    expect(getCanonical).toHaveBeenCalledExactlyOnceWith(calendar.calendlyEventTypeUri);
  });

  it.each<[Partial<CloserCalendarConfig>, CloserLinkStatus]>([
    [{}, "ready"],
    [{ calendlyKind: "group" }, "not_one_on_one"],
    [{ calendlyPoolingType: "round_robin" }, "not_one_on_one"],
    [{ calendlyPoolingType: "round_robin", calendlySoleHostUri: OTHER_USER_URI }, "not_one_on_one"],
    [{ calendlySyncStatus: "inactive" }, "unavailable"],
    [{ calendlySyncStatus: "deleted" }, "unavailable"],
    [{ bookingBaseUrl: undefined, calendlySchedulingUrl: calendar.bookingBaseUrl }, "unavailable"],
    [{ notSalesCallAt: 0 }, "not_sales_call"],
    [{ bookingProgramId: "fixed-program" }, "fixed_program"],
    [{ programFromLinkAt: undefined }, "program_from_link_off"],
  ])("reports %j as %s", (fields, status) => {
    const config = { ...calendar, ...fields };
    expect(calendarStatus(config, closer.calendlyUserUri)).toBe(status);
    expect(closerLinkStatus(closer, [calendar], () => config)).toEqual({ status, config });
  });

  it("matches the synced scheduling URL when it differs from the stored base URL", () => {
    const config = {
      ...calendar,
      bookingBaseUrl: "https://calendly.com/closer/old",
      calendlySchedulingUrl: closer.personalEventTypeUri,
    };

    expect(closerLinkStatus(closer, [config], () => config)).toEqual({ status: "ready", config });
  });

  it("reads codes only on flagged sales calls", () => {
    expect(readsProgramFromLink({ programFromLinkAt: 0 })).toBe(true);
    expect(readsProgramFromLink({ programFromLinkAt: 0, notSalesCallAt: 0 })).toBe(false);
    expect(readsProgramFromLink({})).toBe(false);
  });
});
