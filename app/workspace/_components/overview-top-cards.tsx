"use client";

import { useState } from "react";
import type { DashboardRangeInput } from "./dashboard-date-range-filter";
import type { OverviewDashboard } from "./overview-dashboard-types";
import { LeadGenOverviewCard } from "./lead-gen-overview-card";
import { TopDmClosersCard } from "./top-dm-closers-card";
import { TopQualifiersCard } from "./top-qualifiers-card";

type ExpandedLeaderboardKind = "lead_gen" | "qualifiers" | "dm_closers";

export function OverviewTopCards({
	overview,
	queryRange,
}: {
	overview: OverviewDashboard;
	queryRange: DashboardRangeInput;
}) {
	const [expandedKind, setExpandedKind] =
		useState<ExpandedLeaderboardKind | null>(null);

	return (
		<section
			className="grid grid-cols-1 gap-4 lg:grid-cols-3"
			aria-label="Overview highlights"
		>
			<LeadGenOverviewCard
				section={overview.leadGen}
				range={queryRange}
				expanded={expandedKind === "lead_gen"}
				onExpandedChange={(open) =>
					setExpandedKind(open ? "lead_gen" : null)
				}
			/>
			<TopQualifiersCard
				section={overview.topQualifiers}
				range={queryRange}
				expanded={expandedKind === "qualifiers"}
				onExpandedChange={(open) =>
					setExpandedKind(open ? "qualifiers" : null)
				}
			/>
			<TopDmClosersCard
				section={overview.topDmClosers}
				range={queryRange}
				expanded={expandedKind === "dm_closers"}
				onExpandedChange={(open) =>
					setExpandedKind(open ? "dm_closers" : null)
				}
			/>
		</section>
	);
}
