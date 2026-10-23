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

  const [
    leadGen,
    topQualifiers,
    topDmClosers,
    phoneCloserOperations,
    topOrigins,
  ] = await Promise.all([
    resolveSection(() =>
      getLeadGenOverviewSection(ctx, args.tenantId, range),
      leadGenRebuilding,
    ),
    resolveSection(() =>
      getTopQualifiersOverviewSection(ctx, args.tenantId, range),
    ),
    resolveSection(() =>
      getTopDmClosersOverviewSection(ctx, args.tenantId, range),
    ),
    resolveSection(() =>
      getPhoneCloserOperationsOverviewSection(ctx, args.tenantId, range),
      meetingsRebuilding,
    ),
    resolveSection(() =>
      getTopOriginsOverviewSection(ctx, args.tenantId, range),
      leadGenRebuilding,
    ),
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
