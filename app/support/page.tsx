import type { Metadata } from "next";

import { SupportPageContent } from "./_components/support-page-content";

export const instant = false;

export const metadata: Metadata = {
  title: "Support",
  description: "Support contact information for Magnus CRM and the Magnus Slack app.",
};

export default function SupportPage() {
  return <SupportPageContent />;
}
