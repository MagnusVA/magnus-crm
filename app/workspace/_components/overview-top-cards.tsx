import type { OverviewDashboard } from "./overview-dashboard-types";
import { LeadGenOverviewCard } from "./lead-gen-overview-card";
import { TopDmClosersCard } from "./top-dm-closers-card";
import { TopQualifiersCard } from "./top-qualifiers-card";

export function OverviewTopCards({ overview }: { overview: OverviewDashboard }) {
	return (
		<section
			className="grid grid-cols-1 gap-4 lg:grid-cols-3"
			aria-label="Overview highlights"
		>
			<LeadGenOverviewCard section={overview.leadGen} />
			<TopQualifiersCard section={overview.topQualifiers} />
			<TopDmClosersCard section={overview.topDmClosers} />
		</section>
	);
}
