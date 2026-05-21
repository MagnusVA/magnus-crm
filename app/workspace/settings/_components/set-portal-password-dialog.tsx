"use client";

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useForm } from "react-hook-form";
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

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

  useEffect(() => {
    if (!open) {
      form.reset();
      setSubmitError(null);
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
        error instanceof Error ? error.message : "Could not save password",
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

        <Form {...form}>
          <form
            className="flex flex-col gap-4"
            onSubmit={form.handleSubmit(onSubmit)}
          >
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Portal password <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="password"
                      autoComplete="new-password"
                      disabled={form.formState.isSubmitting}
                      placeholder="Enter portal password…"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Confirm password <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="password"
                      autoComplete="new-password"
                      disabled={form.formState.isSubmitting}
                      placeholder="Confirm portal password…"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                {hasExistingPassword ? "Update Password" : "Set Password"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
