import { PageBand } from "@/app/workspace/_components/page-band";

export function AutomaticResultsBand() {
  return (
    <PageBand
      title="Automatic results"
      description="How far the CRM may go on its own, kind by kind, and the graded record that shows whether it is right."
      back={{ href: "/workspace/settings?tab=integrations", label: "Settings" }}
    />
  );
}
