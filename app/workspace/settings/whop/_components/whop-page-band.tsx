import { PageBand } from "@/app/workspace/_components/page-band";

export function WhopPageBand() {
  return (
    <PageBand
      title="Whop"
      description="Whop payments appear in Billing as evidence. Nothing is recorded as cash until a person confirms it."
      back={{ href: "/workspace/settings?tab=integrations", label: "Settings" }}
    />
  );
}
