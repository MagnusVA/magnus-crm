"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  opensPaymentDialog,
  readPaymentLinkValues,
  type PaymentLinkValues,
} from "@/lib/paymentLink";

/**
 * A meeting or task page opened from a payment link (`?logPayment=1&…`,
 * lib/paymentLink.ts). Returns the link's values while the payment dialog
 * should be open, and `close`, which drops the query from the URL so a
 * reload doesn't open it again. When the call or task can no longer take a
 * payment, it says so once and drops the query. The page's own access check
 * already ran; the mutation checks everything again.
 */
export function usePaymentLink(canPay: boolean): {
  prefill: PaymentLinkValues | null;
  close: () => void;
} {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [closed, setClosed] = useState(false);
  // Once open, the dialog stays until it closes: the payment itself makes
  // the call stop taking one, and that must not unmount the dialog mid-flow.
  const [opened, setOpened] = useState(false);
  const requested = opensPaymentDialog(searchParams) && !closed;
  if (requested && canPay && !opened) setOpened(true);
  const showing = requested && (canPay || opened);
  const values = useMemo(() => readPaymentLinkValues(searchParams), [searchParams]);

  const close = () => {
    setClosed(true);
    router.replace(pathname, { scroll: false });
  };

  // Said once; dropping the query then ends the request.
  const refused = useRef(false);
  useEffect(() => {
    if (!requested || showing || refused.current) return;
    refused.current = true;
    toast.info("This can't take a payment now: its result is already recorded.");
    router.replace(pathname, { scroll: false });
  }, [requested, showing, router, pathname]);

  return { prefill: showing ? values : null, close };
}
