// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_DAY_REBUILD_MESSAGE, type BusinessDaySetting } from "@/lib/businessDay";

const fixture = vi.hoisted(() => ({
  businessDay: undefined as BusinessDaySetting | undefined,
  loaded: true,
  ready: false,
  queries: vi.fn(),
}));
// A tenant whose pages still read Convex (useAnalyticsSource).
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/workspace/reports",
  useRouter: () => ({ replace: () => {} }),
}));
vi.mock("convex/react", () => ({
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    fixture.queries(name, args);
    if (name === "tenants:getCurrentTenant" && fixture.loaded) {
      return { businessDay: fixture.businessDay, businessDayReady: fixture.ready, leadGenBusinessDayReady: true, analyticsReports: [] };
    }
    return undefined;
  },
  useMutation: () => async () => ({ started: false }),
}));

import { LeadGenRanking } from "@/app/workspace/_components/overview-rankings";
import { TopOriginsOverviewSection } from "@/app/workspace/_components/top-origins-overview-section";
import { PhoneCloserOperationsSection } from "@/app/workspace/_components/phone-closer-operations-section";
import { TooltipProvider } from "@/components/ui/tooltip";

// Pages render inside the app layout's TooltipProvider.
const renderPage = (component: () => React.ReactNode) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(component)));

beforeEach(() => { fixture.businessDay = undefined; fixture.loaded = true; fixture.ready = false; fixture.queries.mockClear(); });

describe("Overview sections while the business day rebuilds", () => {
  it("renders rebuilding Overview sections without totals or generic errors", () => {
    const section = { status: "rebuilding" as const, data: null, truncated: false as const, message: BUSINESS_DAY_REBUILD_MESSAGE, errorCode: null };
    const sections = [
      createElement(LeadGenRanking, { section, range: { kind: "preset", preset: "today" } }),
      createElement(TopOriginsOverviewSection, { section }),
      createElement(PhoneCloserOperationsSection, { section }),
    ];
    for (const element of sections) {
      const html = renderToStaticMarkup(createElement(TooltipProvider, null, element));
      expect(html).toContain(BUSINESS_DAY_REBUILD_MESSAGE);
      expect(html).not.toContain("Section unavailable");
      expect(html).not.toContain("Total submissions");
    }
    expect(fixture.queries).not.toHaveBeenCalled();
  });
});
