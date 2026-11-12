import type { CrmRole } from "@/convex/lib/roleMapping";
import {
  ActivityIcon,
  BarChart3Icon,
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarCogIcon,
  CalendarRangeIcon,
  CalendarXIcon,
  ClipboardCheckIcon,
  ContactIcon,
  DollarSignIcon,
  GaugeIcon,
  GitMergeIcon,
  InboxIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  LinkIcon,
  MegaphoneIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  PhoneCallIcon,
  PhoneIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SettingsIcon,
  TargetIcon,
  UsersIcon,
  UsersRoundIcon,
  WaypointsIcon,
  type LucideIcon,
} from "lucide-react";

// The workspace's pages per role: the sidebar draws them, the ⌘1 to ⌘4
// shortcuts follow their order, and the command palette lists them, so the
// three never drift apart.

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  /** Lit for any path under this prefix instead of `href`. */
  activePrefix?: string;
  children?: NavItem[];
};

const leadsCustomersNavItem: NavItem = {
  href: "/workspace/leads-customers",
  label: "Leads & Customers",
  icon: ContactIcon,
};

const operationsNavItem: NavItem = {
  href: "/workspace/operations",
  label: "Operations",
  icon: KanbanIcon,
  children: [
    {
      href: "/workspace/operations/lead-gen",
      label: "Lead Gen",
      icon: MegaphoneIcon,
    },
    {
      href: "/workspace/operations/qualifications",
      label: "Qualifications",
      icon: ClipboardCheckIcon,
    },
    {
      href: "/workspace/operations/booked-calls",
      label: "Booked Calls",
      icon: CalendarCheckIcon,
    },
    {
      href: "/workspace/operations/sales-calls",
      label: "Sales Calls",
      icon: PhoneCallIcon,
    },
    {
      href: "/workspace/operations/missed-meetings",
      label: "No-shows & Cancellations",
      icon: CalendarXIcon,
    },
    {
      href: "/workspace/operations/booking-reviews",
      label: "Booking Reviews",
      icon: GitMergeIcon,
    },
  ],
};

const bookingNavItem: NavItem = {
  href: "/workspace/booking",
  label: "Booking setup",
  icon: CalendarCogIcon,
  children: [
    { href: "/workspace/booking", label: "Coverage", icon: LayoutGridIcon, exact: true },
    { href: "/workspace/booking/inbox", label: "Inbox", icon: InboxIcon },
    { href: "/workspace/booking/event-types", label: "Event types", icon: CalendarRangeIcon },
    { href: "/workspace/booking/portal", label: "Link portal", icon: LinkIcon },
  ],
};

export const REVIEW_HREF = "/workspace/team/review";

// Team › Members is exact: the other sections and redistribute sit under it.
const teamNavItem: NavItem = {
  href: "/workspace/team",
  label: "Team",
  icon: UsersIcon,
  children: [
    { href: "/workspace/team", label: "Members", icon: UsersIcon, exact: true },
    { href: REVIEW_HREF, label: "Review", icon: InboxIcon },
    { href: "/workspace/team/teams", label: "Teams", icon: MessagesSquareIcon },
    { href: "/workspace/team/schedules", label: "Schedules", icon: CalendarClockIcon },
    { href: "/workspace/team/goals", label: "Goals", icon: TargetIcon },
  ],
};

const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  operationsNavItem,
  { href: "/workspace/pipeline/second-opinions", label: "Second opinions", icon: ClipboardCheckIcon },
  leadsCustomersNavItem,
  // Fifth on purpose: ⌘1 to ⌘4 follow this order and keep their pages.
  { href: "/workspace/pipeline/call-insights", label: "Call insights", icon: MessageSquareTextIcon },
  teamNavItem,
  bookingNavItem,
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];

const billingNavItem: NavItem = {
  href: "/workspace/billing",
  label: "Billing",
  icon: DollarSignIcon,
};

/**
 * A closer's or lead generator's own member report (reports:view-own). The
 * page redirects to /workspace/reports/people/<their team member>, so the
 * item stays lit on any member report: the only one they can open.
 */
export const myReportNavItem: NavItem = {
  href: "/workspace/reports/people/me",
  activePrefix: "/workspace/reports/people",
  label: "My report",
  icon: BarChart3Icon,
};

const closerNavItems: NavItem[] = [
  { href: "/workspace/closer", label: "Today", icon: CalendarClockIcon, exact: true },
  { href: "/workspace/closer/pipeline", label: "My Pipeline", icon: KanbanIcon },
  leadsCustomersNavItem,
  myReportNavItem,
];

const leadGeneratorNavItems: NavItem[] = [
  { href: "/workspace/lead-gen/capture", label: "Capture", icon: TargetIcon, exact: true },
  { href: "/workspace/lead-gen/my-activity", label: "My Activity", icon: ActivityIcon },
  { href: "/workspace/lead-gen/respark", label: "Respark", icon: RefreshCwIcon },
  myReportNavItem,
];

// The admins' Reports section (reports:view).
export const reportNavItems: NavItem[] = [
  { href: "/workspace/reports/scorecard", label: "Scorecard", icon: GaugeIcon },
  { href: "/workspace/reports/calls", label: "Calls", icon: PhoneIcon },
  { href: "/workspace/reports/people", label: "People", icon: UsersRoundIcon },
  { href: "/workspace/reports/attribution", label: "Attribution", icon: WaypointsIcon },
  { href: "/workspace/reports/pipeline", label: "Pipeline", icon: ActivityIcon },
  { href: "/workspace/reports/log", label: "Log", icon: ScrollTextIcon },
];

export function navForRole(
  role: CrmRole,
  isAdmin: boolean,
  billingOpsEnabled: boolean,
) {
  if (isAdmin) {
    return billingOpsEnabled
      ? [
          ...adminNavItems.slice(0, 2),
          billingNavItem,
          ...adminNavItems.slice(2),
        ]
      : adminNavItems;
  }
  if (role === "lead_generator") return leadGeneratorNavItems;
  return closerNavItems;
}
