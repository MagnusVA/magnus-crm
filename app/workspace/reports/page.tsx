import { redirect } from "next/navigation";

export const unstable_instant = false;

export default function ReportsPage() {
  redirect("/workspace/reports/team");
}
