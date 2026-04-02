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
    <Alert className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <AlertTriangleIcon />
      <AlertTitle>Calendly Account Not Linked</AlertTitle>
      <AlertDescription className="text-amber-800 dark:text-amber-300">
        Your account is not linked to a Calendly member. Meetings won&apos;t
        appear on your dashboard until an admin connects your profile. Contact
        your team administrator to resolve this.
      </AlertDescription>
    </Alert>
  );
}
