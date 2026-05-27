import { AlertCircleIcon } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

export function BillingUnavailable({ reason }: { reason: string | null }) {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Payment review is gated until the tenant is verified for Billing Ops.
        </p>
      </div>
      <Alert>
        <AlertCircleIcon aria-hidden="true" />
        <AlertTitle>Billing Ops unavailable</AlertTitle>
        <AlertDescription>
          {reason ?? "Billing Ops is not enabled for this tenant."}
        </AlertDescription>
      </Alert>
    </div>
  );
}
