import Link from "next/link";
import { Card } from "@/components/ui/card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";

export function EntityDetailNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col py-12">
      <Card className="gap-0 py-0">
        <SectionEmpty title="This person isn't here.">
          The record was removed, or you don&apos;t have access to it.{" "}
          <Link href="/workspace/leads-customers" className={detailLinkClass}>
            Back to Leads &amp; Customers
          </Link>
        </SectionEmpty>
      </Card>
    </div>
  );
}
