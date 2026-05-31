"use client";

import { EntityActivitySection } from "./entity-activity-section";
import { EntityFieldsIdentifiersSection } from "./entity-fields-identifiers-section";
import { EntityHeaderSection } from "./entity-header-section";
import { EntityIdentityChain } from "./entity-identity-chain";
import { EntityMeetingsSection } from "./entity-meetings-section";
import { EntityOpportunitiesSection } from "./entity-opportunities-section";
import { EntityPaymentsSection } from "./entity-payments-section";
import { OpportunityDetailSheet } from "./opportunity-detail-sheet";
import { OpportunitySheetProvider } from "./opportunity-sheet-context";

export function EntityDetailFrame() {
	return (
		<OpportunitySheetProvider>
			<div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
				<EntityHeaderSection />
				<EntityIdentityChain />
				<EntityOpportunitiesSection />
				<EntityMeetingsSection />
				<EntityPaymentsSection />
				<EntityActivitySection />
				<EntityFieldsIdentifiersSection />
			</div>
			<OpportunityDetailSheet />
		</OpportunitySheetProvider>
	);
}
