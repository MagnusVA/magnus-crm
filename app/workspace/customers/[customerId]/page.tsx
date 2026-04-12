export const unstable_instant = false;

import { CustomerDetailPageClient } from "./_components/customer-detail-page-client";

export default async function CustomerDetailPage({
	params,
}: {
	params: Promise<{ customerId: string }>;
}) {
	const { customerId } = await params;
	return <CustomerDetailPageClient customerId={customerId} />;
}
