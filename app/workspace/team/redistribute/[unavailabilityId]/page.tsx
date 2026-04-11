import type { Id } from "@/convex/_generated/dataModel";
import { RedistributeWizardPageClient } from "./_components/redistribute-wizard-page-client";

export const unstable_instant = false;

export default async function RedistributePage({
	params,
}: {
	params: Promise<{ unavailabilityId: string }>;
}) {
	const { unavailabilityId } = await params;

	return (
		<RedistributeWizardPageClient
			unavailabilityId={
				unavailabilityId as Id<"closerUnavailability">
			}
		/>
	);
}
