import { PageBand } from "@/app/workspace/_components/page-band";

export function WhopPageBand() {
  return (
    <PageBand
      title="Whop"
      description="Whop payments appear in Billing as evidence for payments your team records. They never count as cash by themselves."
      back={{ href: "/workspace/settings?tab=integrations", label: "Settings" }}
    />
  );
}
