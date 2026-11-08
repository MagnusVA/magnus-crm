import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";
import { RedistributeWizardPageClient } from "./_components/redistribute-wizard-page-client";

export const instant = false;

export default async function RedistributePage({
	params,
}: {
	params: Promise<{ unavailabilityId: string }>;
}) {
	// Admins only, as the unavailability queries and redistribution mutations are.
	await requirePermission("reassignment:execute");
	const { unavailabilityId } = await params;

	return (
		<RedistributeWizardPageClient
			unavailabilityId={
				unavailabilityId as Id<"closerUnavailability">
			}
		/>
	);
}
