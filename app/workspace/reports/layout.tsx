import { requirePermission } from "@/lib/auth";

// Closers and lead generators open their own member report (reports:view-own,
// decision D10), so the section lets them in. Every admin page, and the
// roster, requires reports:view on its own page.
export default async function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePermission("reports:view-own");

  return <>{children}</>;
}
