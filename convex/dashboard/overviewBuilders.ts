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
  toPublicOverviewRange,
  type OverviewRangeInput,
} from "./overviewRange";
import { getTopQualifiersOverviewSection } from "./overviewSlack";
import type { OverviewDashboard, SectionResult } from "./overviewTypes";

type SectionBuildResult<T> = {
  data: T;
  truncated?: boolean;
  isEmpty?: boolean;
};

async function resolveSection<T>(
  key: string,
  build: () => Promise<SectionBuildResult<T>>,
): Promise<SectionResult<T>> {
  try {
    const result = await build();
    if (result.isEmpty) {
      return {
        status: "empty",
        data: result.data,
        truncated: false,
        message: "No activity for this range.",
      };
    }

    return {
      status: "ready",
      data: result.data,
      truncated: Boolean(result.truncated),
      message: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (isExpectedRangeCapError(message)) {
      return {
        status: "capped",
        data: null,
        truncated: true,
        message,
      };
    }

    console.error("[Dashboard:Overview] section failed", { key, message });
    return {
      status: "error",
      data: null,
      truncated: false,
      message: "This section could not be loaded.",
    };
  }
}

function isExpectedRangeCapError(message: string) {
  return /too large|cannot exceed|narrow/i.test(message);
}

export async function getOverviewDashboardData(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    range: OverviewRangeInput;
    now: number;
  },
): Promise<OverviewDashboard> {
  const range = deriveOverviewRange(args.range, args.now);

  const [
    leadGen,
    topQualifiers,
    topDmClosers,
    phoneCloserOperations,
    topOrigins,
  ] = await Promise.all([
    resolveSection("leadGen", () =>
      getLeadGenOverviewSection(ctx, args.tenantId, range),
    ),
    resolveSection("topQualifiers", () =>
      getTopQualifiersOverviewSection(ctx, args.tenantId, range),
    ),
    resolveSection("topDmClosers", () =>
      getTopDmClosersOverviewSection(ctx, args.tenantId, range),
    ),
    resolveSection("phoneCloserOperations", () =>
      getPhoneCloserOperationsOverviewSection(ctx, args.tenantId, range),
    ),
    resolveSection("topOrigins", () =>
      getTopOriginsOverviewSection(ctx, args.tenantId, range),
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
