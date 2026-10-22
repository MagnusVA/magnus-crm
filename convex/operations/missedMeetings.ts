import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  attributionsForDeal,
  bookingCreditsByMeeting,
  type BookingCredit,
  type DealAttribution,
} from "../lib/attribution/dealAttributions";
import { LIVE_QUERY_BYTE_BUDGET } from "../lib/liveQueryBounds";
import { isMissedMeetingLoss, type MissedMeeting } from "../opportunities/dealState";
import { assertValidDateRange, getUserDisplayName } from "../reporting/lib/helpers";
import { requireTenantUser } from "../requireTenantUser";

// The No-shows and cancellations list (docs/plans/phase-5-deal-status.md
// §6.5, D17): the deals a missed meeting closed, Closed lost with the
// system's `no_show` or `canceled`, by when they closed, with the person's
// contact details and who worked the deal, for outreach outside the CRM.
// Read-only: it writes nothing and assigns no one.
//
// Each row reads the person, their identifiers, their deals, the meeting and
// the deal's credit rows, so a page holds at most MISSED_MEETINGS_PAGE_SIZE
// deals to stay well under a query's 4,096 reads. The page loads pages until
// it has the rows its export takes, and sorts them by when they closed.

/** The most deals one call reads, missed meetings or not. */
export const MISSED_MEETINGS_PAGE_SIZE = 100;
// Far above the deals and identifiers one person has.
const DEALS_PER_PERSON = 10;
const IDENTIFIERS_PER_PERSON = 50;

const missedMeetingValidator = v.union(v.literal("no_show"), v.literal("canceled"));

const dealSourceValidator = v.union(
  v.literal("calendly"),
  v.literal("slack_qualified"),
  v.literal("side_deal"),
);

const missedMeetingRowValidator = v.object({
  opportunityId: v.id("opportunities"),
  leadId: v.id("leads"),
  personName: v.union(v.string(), v.null()),
  instagramHandle: v.union(v.string(), v.null()),
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  missedMeeting: missedMeetingValidator,
  /** When the missed meeting closed the deal. */
  lostAt: v.number(),
  /** The missed meeting's time: the deal's latest meeting. */
  meetingAt: v.union(v.number(), v.null()),
  source: dealSourceValidator,
  /** The missed meeting's closer; "Removed closer" when the user is gone. */
  closerName: v.union(v.string(), v.null()),
  setterName: v.union(v.string(), v.null()),
  dmCloserName: v.union(v.string(), v.null()),
  dmTeamName: v.union(v.string(), v.null()),
  /** The person has a deal created after this one. */
  bookedAgain: v.boolean(),
});

export type MissedMeetingRow = Infer<typeof missedMeetingRowValidator>;

type MissedDeal = { deal: Doc<"opportunities">; missedMeeting: MissedMeeting };

function isNonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** Loads each key once, sharing the reads between rows. */
function cachedLoader<Key, Value>(load: (key: Key) => Promise<Value>) {
  const loads = new Map<Key, Promise<Value>>();
  return (key: Key) => {
    let pending = loads.get(key);
    if (!pending) {
      pending = load(key);
      loads.set(key, pending);
    }
    return pending;
  };
}

type Contact = { instagramHandle: string | null; email: string | null; phone: string | null };

/**
 * The person's Instagram handle, email and phone: the lead's own fields
 * first, then its identifier rows for any the lead lacks. A suggested
 * identifier, a heuristic nobody confirmed, isn't used.
 */
async function contactOf(ctx: QueryCtx, lead: Doc<"leads">): Promise<Contact> {
  const contact: Contact = {
    instagramHandle:
      lead.socialHandles?.find((handle) => handle.type === "instagram")?.handle ?? null,
    email: lead.email ?? null,
    phone: lead.phone ?? null,
  };
  if (contact.instagramHandle && contact.email && contact.phone) {
    return contact;
  }
  const identifiers = (
    await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", lead._id))
      .take(IDENTIFIERS_PER_PERSON)
  ).filter((identifier) => identifier.tenantId === lead.tenantId && identifier.confidence !== "suggested");
  const first = (type: Doc<"leadIdentifiers">["type"]) =>
    identifiers.find((identifier) => identifier.type === type)?.value ?? null;
  return {
    instagramHandle: contact.instagramHandle ?? first("instagram"),
    email: contact.email ?? first("email"),
    phone: contact.phone ?? first("phone"),
  };
}

/**
 * The credit of the booking behind the missed meeting: the latest meeting's
 * rows, else the deal's first booking's, else its most recent booking's.
 */
function missedBookingCredit(deal: Doc<"opportunities">, rows: DealAttribution[]): BookingCredit {
  const byMeeting = bookingCreditsByMeeting(rows.filter((row) => row.source.kind === "booking_utm"));
  for (const meetingId of [deal.latestMeetingId, deal.firstMeetingId]) {
    const credit = meetingId ? byMeeting.get(meetingId) : undefined;
    if (credit) return credit;
  }
  const latest = rows
    .filter((row) => row.source.kind === "booking_utm" && row.meetingId)
    .sort((left, right) => (right.meetingScheduledAt ?? 0) - (left.meetingScheduledAt ?? 0))[0];
  return latest?.meetingId ? (byMeeting.get(latest.meetingId) ?? {}) : {};
}

async function missedMeetingRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  missed: MissedDeal[],
): Promise<MissedMeetingRow[]> {
  const tenantDoc = <T extends { tenantId: Id<"tenants"> }>(doc: T | null) =>
    doc && doc.tenantId === tenantId ? doc : null;
  const loadLead = cachedLoader(async (leadId: Id<"leads">) =>
    tenantDoc(await ctx.db.get("leads", leadId)),
  );
  const loadContact = cachedLoader(async (leadId: Id<"leads">) => {
    const lead = await loadLead(leadId);
    return lead ? await contactOf(ctx, lead) : null;
  });
  // The person's newest deals, to tell whether they booked again.
  const loadPersonDeals = cachedLoader(async (leadId: Id<"leads">) =>
    await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
      .order("desc")
      .take(DEALS_PER_PERSON),
  );
  const loadUser = cachedLoader(async (userId: Id<"users">) => tenantDoc(await ctx.db.get("users", userId)));
  const loadTeamMember = cachedLoader(async (teamMemberId: Id<"teamMembers">) =>
    tenantDoc(await ctx.db.get("teamMembers", teamMemberId)),
  );
  const loadDmCloser = cachedLoader(async (dmCloserId: Id<"dmClosers">) =>
    tenantDoc(await ctx.db.get("dmClosers", dmCloserId)),
  );
  const loadTeam = cachedLoader(async (teamId: Id<"attributionTeams">) =>
    tenantDoc(await ctx.db.get("attributionTeams", teamId)),
  );

  return await Promise.all(
    missed.map(async ({ deal, missedMeeting }): Promise<MissedMeetingRow> => {
      const [lead, contact, personDeals, meeting, rows] = await Promise.all([
        loadLead(deal.leadId),
        loadContact(deal.leadId),
        loadPersonDeals(deal.leadId),
        deal.latestMeetingId
          ? ctx.db.get("meetings", deal.latestMeetingId).then(tenantDoc)
          : Promise.resolve(null),
        attributionsForDeal(ctx, tenantId, deal._id),
      ]);

      const closerId = meeting?.assignedCloserId ?? deal.assignedCloserId;
      const closer = closerId ? await loadUser(closerId) : null;

      const setterIds = [
        ...new Set(
          rows
            .filter((row) => row.role === "setter")
            .sort((left, right) => left.attributedAt - right.attributedAt)
            .map((row) => row.teamMemberId)
            .filter(isNonNull),
        ),
      ];
      const setters = (await Promise.all(setterIds.map(loadTeamMember))).filter(isNonNull);

      const credit = missedBookingCredit(deal, rows);
      const [dmCloser, team] = await Promise.all([
        credit.dmCloserId ? loadDmCloser(credit.dmCloserId) : Promise.resolve(null),
        credit.teamId ? loadTeam(credit.teamId) : Promise.resolve(null),
      ]);

      return {
        opportunityId: deal._id,
        leadId: deal.leadId,
        personName: lead?.fullName?.trim() || null,
        instagramHandle: contact?.instagramHandle ?? null,
        email: contact?.email ?? null,
        phone: contact?.phone ?? null,
        missedMeeting,
        // Kept only with a loss time in the range.
        lostAt: deal.lostAt!,
        meetingAt: meeting?.scheduledAt ?? deal.latestMeetingAt ?? null,
        source: deal.source ?? "calendly",
        closerName: closerId ? (closer ? getUserDisplayName(closer) : "Removed closer") : null,
        setterName: setters.length > 0 ? setters.map((setter) => setter.displayName).join(", ") : null,
        dmCloserName: dmCloser?.displayName ?? null,
        dmTeamName: team?.displayName ?? null,
        bookedAgain: personDeals.some(
          (other) => other._id !== deal._id && other.createdAt > deal.createdAt,
        ),
      };
    }),
  );
}

/**
 * One page of the deals a missed meeting closed with `lostAt` in
 * [startDate, endDate). A loss is activity, so every deal lost in the range
 * has activity since its start: the read takes Closed lost deals through
 * by_tenantId_and_stage_and_outcome_and_latestActivityAt from `startDate`,
 * most recent activity first, which skips the Slack expiries (they keep
 * their earlier activity time). It reads and leaves out the other losses, a
 * person's and those outside the range, so a page can come back shorter than
 * it read, or empty before the end: keep paging until `isDone`, then sort by
 * `lostAt`. `kind` keeps one kind of missed meeting; `hideBookedAgain`
 * leaves out people with a deal created since.
 */
export const listMissedMeetings = query({
  args: {
    paginationOpts: paginationOptsValidator,
    startDate: v.number(),
    endDate: v.number(),
    kind: v.optional(missedMeetingValidator),
    hideBookedAgain: v.boolean(),
  },
  returns: v.object({
    page: v.array(missedMeetingRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null()),
    ),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    assertValidDateRange(args.startDate, args.endDate);

    const numItems = Math.max(
      1,
      Math.min(Math.floor(args.paginationOpts.numItems), MISSED_MEETINGS_PAGE_SIZE),
    );
    const result = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_stage_and_outcome_and_latestActivityAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("stage", "closed")
          .eq("outcome", "lost")
          .gte("latestActivityAt", args.startDate),
      )
      .order("desc")
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems,
        maximumRowsRead: numItems,
        maximumBytesRead: LIVE_QUERY_BYTE_BUDGET,
      });

    const missed = result.page.flatMap((deal): MissedDeal[] => {
      if (deal.lostAt === undefined || deal.lostAt < args.startDate || deal.lostAt >= args.endDate) {
        return [];
      }
      const missedMeeting = isMissedMeetingLoss(deal);
      return missedMeeting && (args.kind === undefined || args.kind === missedMeeting)
        ? [{ deal, missedMeeting }]
        : [];
    });
    const rows = await missedMeetingRows(ctx, tenantId, missed);

    return {
      page: args.hideBookedAgain ? rows.filter((row) => !row.bookedAgain) : rows,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      splitCursor: result.splitCursor,
      pageStatus: result.pageStatus,
    };
  },
});
