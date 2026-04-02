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
import {
  FieldGroup,
  Field,
  FieldLabel,
} from "@/components/ui/field";
import { Trash2, Plus } from "lucide-react";

interface PaymentLink {
  provider: string;
  label: string;
  url: string;
}

interface PaymentLinkEditorProps {
  links: PaymentLink[];
  onChange: (links: PaymentLink[]) => void;
}

const providers = ["Stripe", "PayPal", "Square"];

export function PaymentLinkEditor({ links, onChange }: PaymentLinkEditorProps) {
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
    <FieldGroup>
      {links.map((link, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field>
              <FieldLabel htmlFor={`provider-${index}`}>Provider</FieldLabel>
              <Select
                value={link.provider}
                onValueChange={(value) =>
                  handleUpdateLink(index, "provider", value)
                }
              >
                <SelectTrigger id={`provider-${index}`}>
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
            </Field>

            <Field>
              <FieldLabel htmlFor={`label-${index}`}>Label</FieldLabel>
              <Input
                id={`label-${index}`}
                placeholder="e.g., Invoice Payment"
                value={link.label}
                onChange={(e) => handleUpdateLink(index, "label", e.target.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={`url-${index}`}>URL</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id={`url-${index}`}
                  type="url"
                  placeholder="https://..."
                  value={link.url}
                  onChange={(e) => handleUpdateLink(index, "url", e.target.value)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveLink(index)}
                  aria-label="Remove payment link"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </Field>
          </div>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleAddLink}
        className="gap-2"
      >
        <Plus className="size-4" />
        Add Payment Link
      </Button>
    </FieldGroup>
  );
}
