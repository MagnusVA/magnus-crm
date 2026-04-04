"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { BanknoteIcon, AlertCircleIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"];
const PROVIDERS = [
  "Stripe",
  "PayPal",
  "Square",
  "Cash",
  "Bank Transfer",
  "Other",
];

/** Max proof file size: 10 MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const VALID_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "application/pdf",
];

type PaymentFormDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
  onSuccess?: () => Promise<void>;
};

/**
 * Payment Form Dialog (Phase 7D)
 *
 * Allows a closer to log a payment for an opportunity:
 * - Amount (required, > 0)
 * - Currency (required, defaults to USD)
 * - Provider (required)
 * - Reference Code (optional)
 * - Proof File (optional, image or PDF up to 10 MB)
 *
 * Two-step file upload:
 * 1. Client calls `generateUploadUrl()` mutation to get a Convex storage URL
 * 2. Client uploads the file directly to that URL
 * 3. Convex returns a storageId
 * 4. Client passes storageId to `logPayment()` mutation
 *
 * On success:
 * - Payment record is created
 * - Opportunity transitions to "payment_received" (terminal state)
 * - Dialog closes and form resets
 */
export function PaymentFormDialog({
  opportunityId,
  meetingId,
  onSuccess,
}: PaymentFormDialogProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [provider, setProvider] = useState("");
  const [referenceCode, setReferenceCode] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logPayment = useMutation(api.closer.payments.logPayment);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > MAX_FILE_SIZE) {
        setError("File size must be less than 10 MB");
        return;
      }
      if (!VALID_FILE_TYPES.includes(file.type)) {
        setError("Only images (JPEG, PNG, GIF) and PDFs are allowed");
        return;
      }
      setProofFile(file);
      setError(null);
    }
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      // Validate required fields
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        throw new Error("Please enter a valid amount greater than 0");
      }
      if (!provider) {
        throw new Error("Please select a payment provider");
      }

      // Upload proof file if provided
      let proofFileId: Id<"_storage"> | undefined;
      if (proofFile) {
        const uploadUrl = await generateUploadUrl();
        const uploadResponse = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": proofFile.type },
          body: proofFile,
        });

        if (!uploadResponse.ok) {
          throw new Error("Failed to upload proof file");
        }

        const uploadData = (await uploadResponse.json()) as {
          storageId?: string;
        };
        if (!uploadData.storageId) {
          throw new Error("File upload returned invalid storage ID");
        }
        proofFileId = uploadData.storageId as Id<"_storage">;
      }

      // Log the payment
      await logPayment({
        opportunityId,
        meetingId,
        amount: parsedAmount,
        currency,
        provider,
        referenceCode: referenceCode || undefined,
        proofFileId,
      });
      await onSuccess?.();

      // Success
      toast.success("Payment logged successfully");
      setOpen(false);
      resetForm();
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to log payment. Please try again.";
      setError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setAmount("");
    setCurrency("USD");
    setProvider("");
    setReferenceCode("");
    setProofFile(null);
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="lg">
          <BanknoteIcon data-icon="inline-start" />
          Log Payment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log Payment</DialogTitle>
          <DialogDescription>
            Record a payment to close this opportunity.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <FieldGroup>
            {/* Amount */}
            <Field>
              <FieldLabel htmlFor="payment-amount">
                Amount <span className="text-destructive">*</span>
              </FieldLabel>
              <Input
                id="payment-amount"
                type="number"
                step="0.01"
                placeholder="299.99"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={isSubmitting}
                min="0"
                required
              />
            </Field>

            {/* Currency */}
            <Field>
              <FieldLabel htmlFor="payment-currency">
                Currency <span className="text-destructive">*</span>
              </FieldLabel>
              <Select
                value={currency}
                onValueChange={setCurrency}
                disabled={isSubmitting}
              >
                <SelectTrigger id="payment-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {CURRENCIES.map((curr) => (
                      <SelectItem key={curr} value={curr}>
                        {curr}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {/* Provider */}
            <Field>
              <FieldLabel htmlFor="payment-provider">
                Provider <span className="text-destructive">*</span>
              </FieldLabel>
              <Select
                value={provider}
                onValueChange={setProvider}
                disabled={isSubmitting}
              >
                <SelectTrigger id="payment-provider">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {PROVIDERS.map((prov) => (
                      <SelectItem key={prov} value={prov}>
                        {prov}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {/* Reference Code */}
            <Field>
              <FieldLabel htmlFor="payment-reference">
                Reference Code
              </FieldLabel>
              <Input
                id="payment-reference"
                type="text"
                placeholder="e.g., pi_3abc123..."
                value={referenceCode}
                onChange={(e) => setReferenceCode(e.target.value)}
                disabled={isSubmitting}
              />
              <FieldDescription>
                Transaction ID from your payment provider
              </FieldDescription>
            </Field>

            {/* Proof File */}
            <Field>
              <FieldLabel htmlFor="payment-proof">Proof File</FieldLabel>
              <Input
                id="payment-proof"
                type="file"
                accept="image/jpeg,image/png,image/gif,application/pdf"
                onChange={handleFileChange}
                disabled={isSubmitting}
                aria-describedby="proof-file-hint"
              />
              {proofFile && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <UploadIcon className="size-3 shrink-0" />
                  <span className="truncate">
                    {proofFile.name} (
                    {(proofFile.size / 1024).toFixed(1)} KB)
                  </span>
                </div>
              )}
              <FieldDescription id="proof-file-hint">
                Max 10 MB. Allowed: PNG, JPEG, GIF, PDF
              </FieldDescription>
            </Field>
          </FieldGroup>

          {/* Error Alert */}
          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertCircleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="mt-5">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                resetForm();
              }}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Logging...
                </>
              ) : (
                "Log Payment"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
