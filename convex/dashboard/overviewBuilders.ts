import { BUSINESS_DAY_REBUILD_MESSAGE } from "../../lib/businessDay";
import { businessDayBucketsReady, leadGenBusinessDayBlocked } from "../lib/businessDayRebuildState";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getLeadGenOverviewSection } from "./overviewLeadGen";
import { getTopOriginsOverviewSection } from "./overviewOrigins";
import {
  getPhoneCloserOperationsOverviewSection,
  getTopDmClosersOverviewSection,
} from "./overviewOperations";
import {
  deriveOverviewRange,
  isRangeCapErrorMessage,
  toPublicOverviewRange,
  type DerivedOverviewRange,
  type OverviewRangeInput,
} from "./overviewRange";
import { getTopQualifiersOverviewSection } from "./overviewSlack";
import type {
  OverviewDashboard,
  SectionErrorCode,
  SectionResult,
} from "./overviewTypes";

type SectionBuildResult<T> = {
  data: T;
  truncated?: boolean;
  isEmpty?: boolean;
};

async function resolveSection<T>(
  build: () => Promise<SectionBuildResult<T>>,
  rebuilding = false,
): Promise<SectionResult<T>> {
  if (rebuilding) {
    return {
      status: "rebuilding",
      data: null,
      truncated: false,
      message: BUSINESS_DAY_REBUILD_MESSAGE,
      errorCode: null,
    };
  }
  try {
    const result = await build();
    if (result.isEmpty) {
      return {
        status: "empty",
        data: result.data,
        truncated: false,
        message: "No activity for this range.",
        errorCode: null,
      };
    }

    return {
      status: "ready",
      data: result.data,
      truncated: Boolean(result.truncated),
      message: null,
      errorCode: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (isRangeCapErrorMessage(message)) {
      return {
        status: "capped",
        data: null,
        truncated: true,
        message,
        errorCode: null,
      };
    }

    // This runs inside a reactive query, so it doesn't log or report: the
    // browser reports a section with `status: "error"` once per mount.
    return {
      status: "error",
      data: null,
      truncated: false,
      message: "This section could not be loaded.",
      errorCode: classifySectionError(message),
    };
  }
}

function classifySectionError(message: string): SectionErrorCode {
  return /\bToo many (?:reads|bytes read|documents read)\b/i.test(message)
    ? "read_limit_exceeded"
    : "unexpected";
}

export async function getOverviewDashboardData(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    range: OverviewRangeInput;
    now: number;
  },
): Promise<OverviewDashboard> {
  const range = deriveOverviewRange(args.range, args.now, await getTenantBusinessDay(ctx, args.tenantId));
  const [tenant, leadGenRebuilding] = await Promise.all([
    ctx.db.get("tenants", args.tenantId),
    leadGenBusinessDayBlocked(ctx, args.tenantId),
  ]);
  const meetingsRebuilding = !tenant || !businessDayBucketsReady(tenant);

  return await buildOverviewDashboard(
    range,
    {
      leadGen: () => getLeadGenOverviewSection(ctx, args.tenantId, range),
      topQualifiers: () =>
        getTopQualifiersOverviewSection(ctx, args.tenantId, range),
      topDmClosers: () =>
        getTopDmClosersOverviewSection(ctx, args.tenantId, range),
      phoneCloserOperations: () =>
        getPhoneCloserOperationsOverviewSection(ctx, args.tenantId, range),
      topOrigins: () => getTopOriginsOverviewSection(ctx, args.tenantId, range),
    },
    { leadGen: leadGenRebuilding, meetings: meetingsRebuilding },
  );
}

type SectionData<Key extends Exclude<keyof OverviewDashboard, "range">> =
  OverviewDashboard[Key] extends SectionResult<infer T> ? T : never;

/**
 * Each Overview section's build, run inside its own section so one failure
 * doesn't take down the page. The Convex path reads the range's buckets and
 * events; the ClickHouse report (convex/analytics/definitions/overview.ts)
 * passes builds over its SQL rows.
 */
export type OverviewSectionBuilds = {
  [Key in Exclude<keyof OverviewDashboard, "range">]: () => Promise<
    SectionBuildResult<SectionData<Key>>
  >;
};

export async function buildOverviewDashboard(
  range: DerivedOverviewRange,
  sections: OverviewSectionBuilds,
  rebuilding: { leadGen: boolean; meetings: boolean },
): Promise<OverviewDashboard> {
  const [
    leadGen,
    topQualifiers,
    topDmClosers,
    phoneCloserOperations,
    topOrigins,
  ] = await Promise.all([
    resolveSection(sections.leadGen, rebuilding.leadGen),
    resolveSection(sections.topQualifiers),
    resolveSection(sections.topDmClosers),
    resolveSection(sections.phoneCloserOperations, rebuilding.meetings),
    resolveSection(sections.topOrigins, rebuilding.leadGen),
  ]);

  return {
    range: toPublicOverviewRange(range),
    leadGen,
    topQualifiers,
    topDmClosers,
    phoneCloserOperations,
    topOrigins,
  };
}
