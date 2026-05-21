"use client";

import { CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

async function copyValue(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error(`Could not copy ${label.toLowerCase()}`);
  }
}

export function OneTimePasswordDialog({
  open,
  password,
  portalUrlPath,
  onOpenChange,
}: {
  open: boolean;
  password: string;
  portalUrlPath: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Portal password generated</DialogTitle>
          <DialogDescription>
            The plaintext password is available only until this dialog closes.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="portal-url-path">Portal path</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="portal-url-path"
                value={portalUrlPath}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="Copy portal path"
                onClick={() => copyValue(portalUrlPath, "Portal path")}
              >
                <CopyIcon />
              </Button>
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor="portal-one-time-password">
              One-time password
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                id="portal-one-time-password"
                value={password}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="Copy one-time password"
                onClick={() => copyValue(password, "Password")}
              >
                <CopyIcon />
              </Button>
            </div>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
