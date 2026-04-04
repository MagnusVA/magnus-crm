import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@/components/ui/alert";
import { AlertTriangleIcon } from "lucide-react";

/**
 * Warning banner shown when the closer's CRM account has no linked
 * Calendly profile (`calendlyUserUri` is unset).
 *
 * Without the link, meetings from Calendly webhooks can't be attributed
 * to the closer, so their dashboard will remain empty.
 */
export function UnmatchedBanner() {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>Calendly Account Not Linked</AlertTitle>
      <AlertDescription>
        Your account is not linked to a Calendly team member.
        Meetings cannot be assigned to you until this is resolved.{" "}
        <strong>Ask your team admin to link your account</strong> in the{" "}
        Team settings page.
      </AlertDescription>
    </Alert>
  );
}
