"use client";

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;

const setPortalPasswordSchema = z
  .object({
    password: z
      .string()
      .min(
        MIN_PASSWORD_LENGTH,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      )
      .max(
        MAX_PASSWORD_LENGTH,
        `Password must be at most ${MAX_PASSWORD_LENGTH} characters`,
      ),
    confirmPassword: z.string().min(1, "Confirm the portal password"),
  })
  .superRefine((values, ctx) => {
    if (values.password !== values.confirmPassword) {
      ctx.addIssue({
        code: "custom",
        message: "Passwords do not match",
        path: ["confirmPassword"],
      });
    }
  });

type SetPortalPasswordValues = z.infer<typeof setPortalPasswordSchema>;

export function SetPortalPasswordDialog({
  open,
  hasExistingPassword,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  hasExistingPassword: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}) {
  const rotatePassword = useAction(
    api.linkPortal.passwordActions.rotatePortalPassword,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(setPortalPasswordSchema),
    defaultValues: {
      password: "",
      confirmPassword: "",
    },
  });

  // Clear any error once the dialog closes.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setSubmitError(null);
  }

  useEffect(() => {
    if (!open) {
      form.reset();
    }
  }, [open, form]);

  async function onSubmit(values: SetPortalPasswordValues) {
    setSubmitError(null);
    try {
      const result = await rotatePassword({ password: values.password });
      toast.success(
        hasExistingPassword
          ? "Portal password updated"
          : "Portal password set",
      );
      if (!hasExistingPassword) {
        toast.message(`Portal path: ${result.portalUrlPath}`);
      }
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      setSubmitError(
        getErrorMessage(error, "Could not save password"),
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {hasExistingPassword ? "Rotate portal password" : "Set portal password"}
          </DialogTitle>
          <DialogDescription>
            Choose a password for external users to access the DM link portal.
            It is stored as a salted hash and never saved in plaintext.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="password"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="portal-password">
                    Portal password <span aria-hidden="true" className="text-danger-ink">*</span>
                  </FieldLabel>
                  <Input
                    {...field}
                    id="portal-password"
                    type="password"
                    autoComplete="new-password"
                    aria-required="true"
                    aria-invalid={fieldState.invalid}
                    disabled={form.formState.isSubmitting}
                    placeholder="Enter portal password…"
                  />
                  <FieldError className="text-[13px] text-danger-ink" errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="confirmPassword"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="portal-password-confirm">
                    Confirm password <span aria-hidden="true" className="text-danger-ink">*</span>
                  </FieldLabel>
                  <Input
                    {...field}
                    id="portal-password-confirm"
                    type="password"
                    autoComplete="new-password"
                    aria-required="true"
                    aria-invalid={fieldState.invalid}
                    disabled={form.formState.isSubmitting}
                    placeholder="Confirm portal password…"
                  />
                  <FieldError className="text-[13px] text-danger-ink" errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>

          {submitError ? (
            <Alert variant="destructive">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={form.formState.isSubmitting}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {hasExistingPassword ? "Update password" : "Set password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
