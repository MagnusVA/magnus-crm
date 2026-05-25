import { requirePermission } from "@/lib/auth";

export default async function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePermission("reports:view");

  return <>{children}</>;
}
