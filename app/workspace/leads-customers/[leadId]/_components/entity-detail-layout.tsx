"use client";

import { EntityActivitySection } from "./entity-activity-section";
import { EntityHeaderSection } from "./entity-header-section";
import { EntityMeetingsSection } from "./entity-meetings-section";
import { EntityOpportunitiesSection } from "./entity-opportunities-section";
import { EntityPaymentsSection } from "./entity-payments-section";
import { EntityPortalNotesSection } from "./entity-portal-notes-section";
import { EntitySnapshotAside } from "./entity-snapshot-aside";
import { OpportunityDetailSheet } from "./opportunity-detail-sheet";
import { OpportunitySheetProvider } from "./opportunity-sheet-context";

export function EntityDetailFrame() {
	return (
		<OpportunitySheetProvider>
			<div className="mx-auto flex w-full max-w-352 flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
				<EntityHeaderSection />
				<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
					<div className="flex min-w-0 flex-col gap-5">
						<EntityOpportunitiesSection />
						<EntityMeetingsSection />
						<EntityPortalNotesSection />
						<EntityPaymentsSection />
						<EntityActivitySection />
					</div>
					<aside className="flex flex-col gap-5 lg:sticky lg:top-4">
						<EntitySnapshotAside />
					</aside>
				</div>
			</div>
			<OpportunityDetailSheet />
		</OpportunitySheetProvider>
	);
}
