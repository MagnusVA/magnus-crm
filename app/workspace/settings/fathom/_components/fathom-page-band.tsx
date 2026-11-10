import { PageBand } from "@/app/workspace/_components/page-band";

export function FathomPageBand() {
  return (
    <PageBand
      title="Fathom"
      description="Ties each sales call's Fathom recording to its meeting. Link each sales recorder to their Magnus user."
      back={{ href: "/workspace/settings?tab=integrations", label: "Settings" }}
    />
  );
}
