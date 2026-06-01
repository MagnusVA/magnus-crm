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
	const [expanded, setExpanded] = useState<
		Record<ExpandedLeaderboardKind, boolean>
	>({
		lead_gen: false,
		qualifiers: false,
		dm_closers: false,
	});

	const setCardExpanded =
		(kind: ExpandedLeaderboardKind) => (open: boolean) => {
			setExpanded((current) => ({
				...current,
				[kind]: open,
			}));
		};

	return (
		<section
			className="grid grid-cols-1 gap-4 lg:grid-cols-3"
			aria-label="Overview highlights"
		>
			<LeadGenOverviewCard
				section={overview.leadGen}
				range={queryRange}
				expanded={expanded.lead_gen}
				onExpandedChange={setCardExpanded("lead_gen")}
			/>
			<TopQualifiersCard
				section={overview.topQualifiers}
				range={queryRange}
				expanded={expanded.qualifiers}
				onExpandedChange={setCardExpanded("qualifiers")}
			/>
			<TopDmClosersCard
				section={overview.topDmClosers}
				range={queryRange}
				expanded={expanded.dm_closers}
				onExpandedChange={setCardExpanded("dm_closers")}
			/>
		</section>
	);
}
