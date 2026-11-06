import { PageBand } from "@/app/workspace/_components/page-band";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";

/** Billing before the workspace is cleared for Billing Ops: the band and one line saying why. */
export function BillingUnavailable({ reason }: { reason: string | null }) {
  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand title="Billing" description="Recorded payments to check before they go to external billing." />
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex min-h-11 items-center border-b px-4 py-2">
          <h2 className="text-[15px] font-semibold">Payments</h2>
        </div>
        <SectionEmpty title={reason ?? "Billing Ops is not enabled for this tenant."}>
          Payment review opens once the workspace is verified for Billing Ops.
        </SectionEmpty>
      </div>
    </div>
  );
}
