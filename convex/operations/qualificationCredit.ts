import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { dealBookingCredit } from "../lib/attribution/dealAttributions";
import type { attributionResolutionValidator } from "../lib/attribution/validators";
import { dmCloserMemberIdentity, type MemberAvatarIdentity } from "../lib/memberIdentity";

type QualificationRowRef = Pick<Doc<"operationsQualificationRows">, "opportunityId">;

/** The DM credit a qualification row shows for its deal. */
export type QualificationRowCredit = {
  attributionTeamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
  attributionResolution: Infer<typeof attributionResolutionValidator>;
  attributionTeamName?: string;
  dmCloserName?: string;
  dmCloser: MemberAvatarIdentity | null;
};

type DealCredit = Pick<
  QualificationRowCredit,
  "attributionTeamId" | "dmCloserId" | "attributionResolution"
>;

const NO_CREDIT: DealCredit = { attributionResolution: "none" };

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

async function firstBookingCredit(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  opportunityId: Id<"opportunities">,
): Promise<DealCredit> {
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId || !opportunity.firstMeetingId) {
    return NO_CREDIT;
  }
  const [credit, firstMeeting] = await Promise.all([
    dealBookingCredit(ctx, opportunity),
    ctx.db.get("meetings", opportunity.firstMeetingId),
  ]);
  return {
    attributionTeamId: credit.teamId,
    dmCloserId: credit.dmCloserId,
    attributionResolution:
      firstMeeting?.tenantId === tenantId
        ? (firstMeeting.attributionResolution ?? "none")
        : "none",
  };
}

/**
 * The DM team, DM closer and resolution each qualification row shows: its
 * deal's first external booking's (docs/plans/phase-3-attribution.md §6.2),
 * read from that booking's attribution rows and its meeting. A row with no
 * deal, or a deal never booked, shows none.
 */
export async function loadQualificationRowCredits(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: readonly QualificationRowRef[],
): Promise<(row: QualificationRowRef) => QualificationRowCredit> {
  const opportunityIds = [
    ...new Set(rows.flatMap((row) => (row.opportunityId ? [row.opportunityId] : []))),
  ];
  const dealCredits = new Map(
    await Promise.all(
      opportunityIds.map(
        async (opportunityId) =>
          [opportunityId, await firstBookingCredit(ctx, tenantId, opportunityId)] as const,
      ),
    ),
  );

  const credits = [...dealCredits.values()];
  const teamIds = [
    ...new Set(credits.flatMap((credit) => (credit.attributionTeamId ? [credit.attributionTeamId] : []))),
  ];
  const dmCloserIds = [
    ...new Set(credits.flatMap((credit) => (credit.dmCloserId ? [credit.dmCloserId] : []))),
  ];
  const [teams, dmClosers] = await Promise.all([
    Promise.all(teamIds.map((id) => ctx.db.get("attributionTeams", id))),
    Promise.all(dmCloserIds.map((id) => ctx.db.get("dmClosers", id))),
  ]);

  const teamNameById = new Map(
    teams
      .filter(isNonNull)
      .filter((team) => team.tenantId === tenantId)
      .map((team) => [team._id, team.displayName]),
  );
  const dmCloserById = new Map(
    await Promise.all(
      dmClosers
        .filter(isNonNull)
        .filter((dmCloser) => dmCloser.tenantId === tenantId)
        .map(async (dmCloser) => {
          const linkedUser = dmCloser.userId
            ? await ctx.db.get("users", dmCloser.userId)
            : null;
          const identity = await dmCloserMemberIdentity(
            ctx,
            dmCloser,
            linkedUser?.tenantId === tenantId ? linkedUser : null,
          );
          return [dmCloser._id, { name: dmCloser.displayName, identity }] as const;
        }),
    ),
  );

  return (row) => {
    const credit = (row.opportunityId && dealCredits.get(row.opportunityId)) || NO_CREDIT;
    const dmCloser = credit.dmCloserId ? dmCloserById.get(credit.dmCloserId) : undefined;
    return {
      attributionTeamId: credit.attributionTeamId,
      dmCloserId: credit.dmCloserId,
      attributionResolution: credit.attributionResolution,
      attributionTeamName: credit.attributionTeamId
        ? teamNameById.get(credit.attributionTeamId)
        : undefined,
      dmCloserName: dmCloser?.name,
      dmCloser: dmCloser?.identity ?? null,
    };
  };
}
