import type { CrmRole } from "@/convex/lib/roleMapping";
import {
  ActivityIcon,
  AlarmClockCheckIcon,
  BarChart3Icon,
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarCogIcon,
  CalendarRangeIcon,
  CalendarXIcon,
  ClipboardCheckIcon,
  ClockIcon,
  ContactIcon,
  DollarSignIcon,
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
  RefreshCwIcon,
  SettingsIcon,
  TargetIcon,
  TrendingUpIcon,
  UsersIcon,
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
  teamNavItem,
  bookingNavItem,
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];

const billingNavItem: NavItem = {
  href: "/workspace/billing",
  label: "Billing",
  icon: DollarSignIcon,
};

const closerNavItems: NavItem[] = [
  { href: "/workspace/closer", label: "Today", icon: CalendarClockIcon, exact: true },
  { href: "/workspace/closer/pipeline", label: "My Pipeline", icon: KanbanIcon },
  leadsCustomersNavItem,
];

const leadGeneratorNavItems: NavItem[] = [
  { href: "/workspace/lead-gen/capture", label: "Capture", icon: TargetIcon, exact: true },
  { href: "/workspace/lead-gen/my-activity", label: "My Activity", icon: ActivityIcon },
  { href: "/workspace/lead-gen/respark", label: "Respark", icon: RefreshCwIcon },
];

export const reportNavItems: NavItem[] = [
  { href: "/workspace/reports/team", label: "Team Performance", icon: BarChart3Icon },
  { href: "/workspace/reports/revenue", label: "Revenue", icon: DollarSignIcon },
  { href: "/workspace/reports/pipeline", label: "Pipeline Health", icon: ActivityIcon },
  { href: "/workspace/reports/leads", label: "Leads & Conversions", icon: TrendingUpIcon },
  { href: "/workspace/reports/activity", label: "Activity Feed", icon: ClockIcon },
  { href: "/workspace/reports/reminders", label: "Reminders", icon: AlarmClockCheckIcon },
  {
    href: "/workspace/reports/slack-qualifications",
    label: "Slack Qualifications",
    icon: MessageSquareTextIcon,
  },
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
