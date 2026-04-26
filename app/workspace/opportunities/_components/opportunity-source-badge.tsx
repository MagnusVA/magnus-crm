import { Badge } from "@/components/ui/badge";

export function OpportunitySourceBadge({
  source,
}: {
  source: "calendly" | "side_deal";
}) {
  return (
    <Badge variant={source === "side_deal" ? "secondary" : "outline"}>
      {source === "side_deal" ? "Side deal" : "Calendly"}
    </Badge>
  );
}
