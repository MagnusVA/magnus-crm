"use client";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

// The role picker the invite and role dialogs share: each role says what it
// lets the person do (convex/lib/permissions.ts) before it is chosen.

export type CrmRole = "closer" | "lead_generator" | "tenant_admin";

export const CRM_ROLES: Array<{ value: CrmRole; label: string; consequence: string }> = [
  { value: "closer", label: "Closer", consequence: "Takes calls and records payments on assigned deals." },
  { value: "lead_generator", label: "Lead Generator", consequence: "Logs leads and works Respark. No calls or deals." },
  { value: "tenant_admin", label: "Admin", consequence: "Sees everything. Manages the team, billing and settings." },
];

export function roleLabel(role: string) {
  return CRM_ROLES.find((option) => option.value === role)?.label;
}

/** The three CRM roles as radio rows, each with its consequence in a slate line. */
export function RoleChoices({
  id,
  value,
  onChange,
  currentRole,
  disabled,
  invalid,
}: {
  /** Prefix for the radio ids. */
  id: string;
  value: string;
  onChange: (role: CrmRole) => void;
  /** Marks the role the person has now. */
  currentRole?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as CrmRole)}
      disabled={disabled}
      aria-label="Role"
      aria-invalid={invalid || undefined}
      className="gap-0"
    >
      {CRM_ROLES.map((option) => (
        <div key={option.value} className="flex gap-2.5 py-1.5 first:pt-0 last:pb-0 @lg:first:pt-2">
          <RadioGroupItem value={option.value} id={`${id}-${option.value}`} className="mt-0.5" />
          <Label
            htmlFor={`${id}-${option.value}`}
            className={cn("flex min-w-0 flex-col items-start gap-0.5 font-normal", disabled && "opacity-60")}
          >
            <span className="text-sm font-medium">
              {option.label}
              {option.value === currentRole ? <span className="font-normal text-muted-foreground"> · now</span> : null}
            </span>
            <span className="text-[13px] leading-[1.45] text-muted-foreground">{option.consequence}</span>
          </Label>
        </div>
      ))}
    </RadioGroup>
  );
}
