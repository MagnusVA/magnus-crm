import { requirePermission } from "@/lib/auth";
import { CustomerDetailPageClient } from "./_components/customer-detail-page-client";

export const unstable_instant = false;

export default async function CustomerDetailPage({
	params,
}: {
	params: Promise<{ customerId: string }>;
}) {
	await requirePermission("customer:view-own");
	const { customerId } = await params;
	return <CustomerDetailPageClient customerId={customerId} />;
}
