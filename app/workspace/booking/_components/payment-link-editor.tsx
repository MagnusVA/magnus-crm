"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Plus } from "lucide-react";

interface PaymentLink {
  provider: string;
  label: string;
  url: string;
}

interface PaymentLinkEditorProps {
  links: PaymentLink[];
  onChange: (links: PaymentLink[]) => void;
  disabled?: boolean;
}

const providers = ["Stripe", "PayPal", "Square"];

/**
 * The event type's payment links, one line each: provider, label, URL and
 * remove. Folds to two lines in a narrow container.
 */
export function PaymentLinkEditor({ links, onChange, disabled }: PaymentLinkEditorProps) {
  const handleAddLink = () => {
    onChange([...links, { provider: "Stripe", label: "", url: "" }]);
  };

  const handleRemoveLink = (index: number) => {
    onChange(links.filter((_, i) => i !== index));
  };

  const handleUpdateLink = (
    index: number,
    field: keyof PaymentLink,
    value: string
  ) => {
    const updated = [...links];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  };

  return (
    <div className="flex flex-col gap-2">
      {links.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No payment links yet.</p>
      ) : null}
      {links.map((link, index) => (
        <div
          key={index}
          className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-2 @lg:grid-cols-[7rem_minmax(0,0.8fr)_minmax(0,1.2fr)_auto]"
        >
          <Select
            value={link.provider}
            onValueChange={(value) => handleUpdateLink(index, "provider", value)}
            disabled={disabled}
          >
            <SelectTrigger aria-label={`Payment link ${index + 1} provider`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            aria-label={`Payment link ${index + 1} label`}
            placeholder="Label, e.g. Deposit"
            value={link.label}
            onChange={(e) => handleUpdateLink(index, "label", e.target.value)}
            disabled={disabled}
            className="col-span-2 @lg:col-span-1"
          />

          <Input
            aria-label={`Payment link ${index + 1} URL`}
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder="https://..."
            value={link.url}
            onChange={(e) => handleUpdateLink(index, "url", e.target.value)}
            disabled={disabled}
            className="col-span-2 text-[13px] @lg:col-span-1"
          />

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => handleRemoveLink(index)}
            aria-label={`Remove payment link ${index + 1}`}
            disabled={disabled}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleAddLink}
        disabled={disabled}
        className="self-start"
      >
        <Plus data-icon="inline-start" aria-hidden />
        Add payment link
      </Button>
    </div>
  );
}
