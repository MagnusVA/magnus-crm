// Closer links: a DM setter copies a phone closer's personal Calendly link
// with the program's link code in `utm_content`. Pure rules shared by the
// admin tab, the portal, the copy check and the booking pipeline.

import { isCalendlyBookable, linkIssue, type CoverageEventType } from "./bookingSetup/coverage";

/** A program link code: lowercase letters, digits and inner dashes, 1-24 long. */
const LINK_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
export const LINK_CODE_MAX_LENGTH = 24;

export function normalizeLinkCode(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isLinkCode(code: string): boolean {
  return LINK_CODE_PATTERN.test(code);
}

/** A code suggested from a program name, such as "25K Accelerator" -> "25k-accelerator". */
export function slugifyLinkCode(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LINK_CODE_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || "program";
}

/** The first of `base`, `base-2`, `base-3`... that isn't taken, within the length limit. */
export function pickUniqueLinkCode(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const tail = `-${suffix}`;
    const head = base.slice(0, LINK_CODE_MAX_LENGTH - tail.length).replace(/-+$/g, "");
    const candidate = `${head || "program"}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Every code a program holds, its current one and the ones it retired. */
export function programLinkCodes(program: {
  linkCode?: string;
  retiredLinkCodes?: string[];
}): string[] {
  return [
    ...(program.linkCode ? [program.linkCode] : []),
    ...(program.retiredLinkCodes ?? []),
  ];
}

/**
 * A Calendly booking URL reduced to host and path, so a pasted link matches
 * the synced scheduling URL whatever its case, query or trailing slash.
 */
export function bookingUrlKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const path = parsed.pathname.replace(/\/+$/g, "").toLowerCase();
    return `${parsed.hostname.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

export function sameBookingUrl(left: string | undefined, right: string | undefined) {
  const leftKey = bookingUrlKey(left);
  return leftKey !== null && leftKey === bookingUrlKey(right);
}

/** The URL a closer link starts from: the synced scheduling URL, else the stored base URL. */
export function closerCalendarUrl(config: {
  calendlySchedulingUrl?: string;
  bookingBaseUrl?: string;
}): string | undefined {
  return config.calendlySchedulingUrl ?? config.bookingBaseUrl;
}

export type CloserCalendarConfig = CoverageEventType & {
  _id: string;
  calendlyEventTypeUri: string;
  calendlyOwnerUri?: string;
  calendlySoleHostUri?: string;
  calendlyKind?: string;
  calendlyPoolingType?: string;
  notSalesCallAt?: number;
  programFromLinkAt?: number;
  createdAt: number;
};

/** Pooled event types that count as one person's calendar when they have a single host. */
export const SINGLE_HOST_POOLING_TYPES: ReadonlySet<string> = new Set(["round_robin"]);

/**
 * The Calendly user whose own calendar this event type is, if it is one
 * person's: a one-on-one event type's owner, or the only host of a round
 * robin as the event type sync last verified it. Group, collective and
 * multi-pool event types are nobody's.
 */
export function calendarHolderUri(
  config: Pick<
    CloserCalendarConfig,
    "calendlyKind" | "calendlyPoolingType" | "calendlyOwnerUri" | "calendlySoleHostUri"
  >,
): string | undefined {
  if (config.calendlyKind !== undefined && config.calendlyKind !== "solo") return undefined;
  if (!config.calendlyPoolingType) return config.calendlyOwnerUri;
  if (SINGLE_HOST_POOLING_TYPES.has(config.calendlyPoolingType)) return config.calendlySoleHostUri;
  return undefined;
}

/** Whether Calendly ties this event type to the user at all, as owner or sole host. */
export function isTiedToUser(
  config: Pick<CloserCalendarConfig, "calendlyOwnerUri" | "calendlySoleHostUri">,
  calendlyUserUri: string | undefined,
): boolean {
  return (
    calendlyUserUri !== undefined &&
    (config.calendlyOwnerUri === calendlyUserUri || config.calendlySoleHostUri === calendlyUserUri)
  );
}

/** Whether the booking pipeline may read a program code for bookings on this event type. */
export function readsProgramFromLink(config: {
  programFromLinkAt?: number;
  notSalesCallAt?: number;
}): boolean {
  return config.programFromLinkAt !== undefined && config.notSalesCallAt === undefined;
}

export type CloserLinkStatus =
  | "ready"
  | "deactivated"
  | "not_closer"
  | "calendly_not_linked"
  | "needs_link"
  | "not_their_calendar"
  | "ambiguous"
  | "too_many_calendars"
  | "not_one_on_one"
  | "unavailable"
  | "not_sales_call"
  | "fixed_program"
  | "program_from_link_off";

export const CLOSER_LINK_STATUS_LABEL: Record<CloserLinkStatus, string> = {
  ready: "Ready",
  deactivated: "Deactivated",
  not_closer: "Not a phone closer",
  calendly_not_linked: "Not linked to a Calendly member",
  needs_link: "Needs a link",
  not_their_calendar: "Not one of their Calendly event types",
  ambiguous: "Matches more than one event type",
  too_many_calendars: "Too many Calendly event types to check",
  not_one_on_one: "Not a one-person event type",
  unavailable: "Inactive in Calendly or missing its URL",
  not_sales_call: "Marked not a sales call",
  fixed_program: "Event type has a fixed program",
  program_from_link_off: "Save the link to finish setup",
};

type CloserForStatus = {
  role: string;
  isActive: boolean;
  deletedAt?: number;
  calendlyUserUri?: string;
  personalEventTypeUri?: string;
};

/**
 * Where a closer's personal link stands. `ownedConfigs` are the event types
 * Calendly ties to the closer (as owner or verified sole host);
 * `canonicalConfigFor` returns the config the booking pipeline reads for a
 * Calendly event type URI (the oldest one), so Ready here means the pipeline
 * will read the program code.
 */
export function closerLinkStatus<Config extends CloserCalendarConfig>(
  user: CloserForStatus,
  ownedConfigs: readonly Config[],
  canonicalConfigFor: (calendlyEventTypeUri: string) => Config | null,
): { status: CloserLinkStatus; config: Config | null } {
  if (!user.isActive || user.deletedAt !== undefined) {
    return { status: "deactivated", config: null };
  }
  if (user.role !== "closer") return { status: "not_closer", config: null };
  if (!user.calendlyUserUri) return { status: "calendly_not_linked", config: null };
  if (!user.personalEventTypeUri) return { status: "needs_link", config: null };

  // A deleted or inactive event type can share its URL with its replacement.
  const matches = ownedConfigs.filter(
    (config) =>
      isTiedToUser(config, user.calendlyUserUri) &&
      isCalendlyBookable(config) &&
      sameBookingUrl(closerCalendarUrl(config), user.personalEventTypeUri),
  );
  const uris = new Set(matches.map((config) => config.calendlyEventTypeUri));
  if (uris.size === 0) return { status: "not_their_calendar", config: null };
  if (uris.size > 1) return { status: "ambiguous", config: null };

  const [uri] = [...uris];
  // The pipeline reads the canonical (oldest) config, so it must be theirs too.
  const config = uri ? canonicalConfigFor(uri) : null;
  if (!config || !isTiedToUser(config, user.calendlyUserUri)) {
    return { status: "not_their_calendar", config: null };
  }
  return { status: calendarStatus(config, user.calendlyUserUri), config };
}

/** Whether an event type Calendly ties to this person can carry their closer links. */
export function calendarStatus(
  config: CloserCalendarConfig,
  calendlyUserUri: string | undefined,
): CloserLinkStatus {
  if (calendlyUserUri === undefined || calendarHolderUri(config) !== calendlyUserUri) {
    return "not_one_on_one";
  }
  if (linkIssue(config) !== null) return "unavailable";
  if (config.notSalesCallAt !== undefined) return "not_sales_call";
  if (config.bookingProgramId !== undefined) return "fixed_program";
  if (config.programFromLinkAt === undefined) return "program_from_link_off";
  return "ready";
}

/** A closer link: the closer's calendar URL with the setter's UTMs and the program code. */
export function buildCloserLinkUrl(input: {
  calendarUrl: string;
  teamUtmSource: string;
  dmCloserUtmMedium: string;
  utmCampaign: string;
  programLinkCode: string;
}): string {
  const url = new URL(input.calendarUrl);
  url.searchParams.set("utm_source", input.teamUtmSource);
  url.searchParams.set("utm_medium", input.dmCloserUtmMedium);
  url.searchParams.set("utm_campaign", input.utmCampaign);
  url.searchParams.set("utm_content", input.programLinkCode);
  return url.toString();
}
