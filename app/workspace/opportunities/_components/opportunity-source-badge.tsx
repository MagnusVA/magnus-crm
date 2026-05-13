import { Badge } from "@/components/ui/badge";

export function OpportunitySourceBadge({
  source,
}: {
  source: "calendly" | "side_deal" | "slack_qualified";
}) {
  if (source === "slack_qualified") {
    return <Badge variant="outline">Slack qualified</Badge>;
  }

  return (
    <Badge variant={source === "side_deal" ? "secondary" : "outline"}>
      {source === "side_deal" ? "Side deal" : "Calendly"}
    </Badge>
  );
}
