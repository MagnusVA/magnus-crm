"use client";

import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { AlertCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import { CARD, CardHead, plural } from "@/app/workspace/team/_components/team-ui";
import { ActionRow, NoteLine } from "@/app/workspace/settings/_components/settings-ui";
import { ScopeList, WHOP_CATALOG_SCOPES } from "@/components/whop/whop-settings-parts";
import { getErrorCode, getErrorMessage } from "@/lib/errors";
import { formatCurrency } from "@/lib/format-currency";
import { cn } from "@/lib/utils";

type Catalog = FunctionReturnType<typeof api.payments.bindings.listCatalog>;
type ConnectionId = Id<"tenantPaymentConnections">;
type BindingId = Id<"paymentProviderBindings">;

// The same four types, in the same words, as the payment dialogs.
const PAYMENT_TYPES = ["monthly", "split", "pif", "deposit"] as const;
type PaymentType = (typeof PAYMENT_TYPES)[number];
const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  monthly: "Monthly",
  split: "Split",
  pif: "Paid in Full",
  deposit: "Deposit",
};
const LATER_TYPES = ["monthly", "split", "pif"] as const satisfies readonly PaymentType[];
const LATER_NONE = "none";

type ProductBinding = { bindingId: BindingId; programId: Id<"tenantPrograms"> };
type VariantBinding = { bindingId: BindingId; paymentType: PaymentType; laterPaymentType?: PaymentType };
type ProductRow = Omit<Catalog["products"][number], "binding"> & { binding: ProductBinding | null };
type VariantRow = Omit<Catalog["variants"][number], "binding"> & { binding: VariantBinding | null };

type CatalogState =
  | { kind: "loading" }
  | { kind: "error"; code: string | undefined; message: string }
  | {
      kind: "ready";
      products: ProductRow[];
      variants: VariantRow[];
      nextProductCursor: string | null;
      nextVariantCursor: string | null;
    };

function toRows(page: Catalog) {
  return {
    products: page.products.map(
      (product): ProductRow => ({
        ...product,
        binding: product.binding ? { bindingId: product.binding.bindingId, programId: product.binding.programId } : null,
      }),
    ),
    variants: page.variants.map(
      (variant): VariantRow => ({
        ...variant,
        binding: variant.binding
          ? {
              bindingId: variant.binding.bindingId,
              paymentType: variant.binding.paymentType,
              laterPaymentType: variant.binding.laterPaymentType,
            }
          : null,
      }),
    ),
  };
}

/** A failed catalog read, in one plain sentence. */
function catalogErrorSentence(error: unknown) {
  switch (getErrorCode(error)) {
    case "whop.unauthorized":
      return "Whop rejected the API key. Connect again with a new key.";
    case "whop.account_mismatch":
      return "Whop returned products from a different account. Check the API key.";
    case "whop.provider_unavailable":
      return "Magnus couldn't reach Whop. Try again in a minute.";
    case "whop.disconnected":
    case "whop.connection_changed":
      return "The Whop connection changed while loading. Try again.";
    default:
      return getErrorMessage(error, "Couldn't load products and prices from Whop. Try again.");
  }
}

/**
 * Whop's products, each mapped to a program, with its prices under it, each
 * mapped to a payment type. Every change saves on its own, with a toast. The
 * catalog comes from Whop a page at a time, so the card keeps what it read and
 * updates rows in place as they're saved.
 */
export function WhopCatalogCard({ connectionId }: { connectionId: ConnectionId }) {
  const listCatalog = useAction(api.payments.bindings.listCatalog);
  const [state, setState] = useState<CatalogState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listCatalog({ connectionId }).then(
      (page) => {
        if (cancelled) return;
        setState({
          kind: "ready",
          ...toRows(page),
          nextProductCursor: page.nextProductCursor,
          nextVariantCursor: page.nextVariantCursor,
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", code: getErrorCode(error), message: catalogErrorSentence(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [listCatalog, connectionId, attempt]);

  function retry() {
    setState({ kind: "loading" });
    setAttempt((value) => value + 1);
  }

  async function loadMore() {
    if (state.kind !== "ready") return;
    setLoadingMore(true);
    try {
      const page = await listCatalog({
        connectionId,
        productCursor: state.nextProductCursor,
        variantCursor: state.nextVariantCursor,
      });
      const rows = toRows(page);
      setState((previous) =>
        previous.kind === "ready"
          ? {
              kind: "ready",
              products: [...previous.products, ...rows.products],
              variants: [...previous.variants, ...rows.variants],
              nextProductCursor: page.nextProductCursor,
              nextVariantCursor: page.nextVariantCursor,
            }
          : previous,
      );
    } catch (error) {
      toast.error(catalogErrorSentence(error));
    } finally {
      setLoadingMore(false);
    }
  }

  function setProductBinding(productId: string, binding: ProductBinding | null) {
    setState((previous) =>
      previous.kind === "ready"
        ? {
            ...previous,
            products: previous.products.map((row) => (row.productId === productId ? { ...row, binding } : row)),
          }
        : previous,
    );
  }

  function setVariantBinding(variantId: string, binding: VariantBinding | null) {
    setState((previous) =>
      previous.kind === "ready"
        ? {
            ...previous,
            variants: previous.variants.map((row) => (row.variantId === variantId ? { ...row, binding } : row)),
          }
        : previous,
    );
  }

  const meta =
    state.kind === "ready"
      ? `${state.products.filter((row) => row.binding).length} of ${plural(state.products.length, "product")} mapped`
      : undefined;

  return (
    <section aria-label="Whop products and prices" className={CARD} aria-busy={state.kind === "loading" || undefined}>
      <CardHead title="Products and prices" meta={meta} />
      <p className="border-b border-border px-4 py-2.5 text-[13px] leading-[1.45] text-muted-foreground">
        Map each Whop product to a program and each price to a payment type, so Billing can propose them. Products and
        prices left unmapped still appear in Billing for a person to sort.
      </p>
      {state.kind === "loading" ? <CatalogSkeleton /> : null}
      {state.kind === "error" ? <CatalogError code={state.code} message={state.message} onRetry={retry} /> : null}
      {state.kind === "ready" ? (
        <>
          {state.products.length === 0 && state.variants.length === 0 ? (
            <div className="px-4 py-4">
              <p className="text-sm font-medium">No products in this Whop account yet.</p>
              <NoteLine>Products and their prices appear here once you create them in Whop.</NoteLine>
            </div>
          ) : (
            <CatalogList
              connectionId={connectionId}
              products={state.products}
              variants={state.variants}
              moreProducts={state.nextProductCursor !== null}
              onProductSaved={setProductBinding}
              onVariantSaved={setVariantBinding}
            />
          )}
          {state.nextProductCursor !== null || state.nextVariantCursor !== null ? (
            <ActionRow>
              <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? <Spinner data-icon="inline-start" /> : null}
                <TranslatableText>{loadingMore ? "Loading…" : "Load more"}</TranslatableText>
              </Button>
            </ActionRow>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function CatalogSkeleton() {
  return (
    <div role="status" aria-label="Loading products and prices from Whop">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex min-h-12 items-center gap-3 border-b border-border px-4 py-2 last:border-b-0">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="h-7 w-44 max-w-[40%]" />
        </div>
      ))}
    </div>
  );
}

function CatalogError({ code, message, onRetry }: { code: string | undefined; message: string; onRetry: () => void }) {
  if (code === "whop.forbidden") {
    return (
      <div className="flex flex-col gap-2 px-4 py-4">
        <p className="text-sm font-medium">Magnus can&apos;t read your products and prices yet.</p>
        <NoteLine>
          The API key doesn&apos;t allow it. Add <ScopeList scopes={WHOP_CATALOG_SCOPES} /> to the key in Whop, then try
          again. Payments still arrive without them.
        </NoteLine>
        <div>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 px-4 py-4">
      <p role="alert" className="flex items-start gap-2 text-[13px] leading-[1.45] text-danger-ink">
        <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {message}
      </p>
      <div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

type Group = { key: string; product: ProductRow | null; title: string; variants: VariantRow[] };

/** Products in Whop's order with their prices under them; prices whose product isn't loaded yet come last. */
function groupCatalog(products: ProductRow[], variants: VariantRow[]): Group[] {
  const byProduct = new Map<string, VariantRow[]>();
  for (const variant of variants) {
    const key = variant.productId ?? "";
    byProduct.set(key, [...(byProduct.get(key) ?? []), variant]);
  }
  const groups: Group[] = products.map((product) => ({
    key: product.productId,
    product,
    title: product.title,
    variants: byProduct.get(product.productId) ?? [],
  }));
  const loaded = new Set(products.map((product) => product.productId));
  for (const [key, rows] of byProduct) {
    if (loaded.has(key)) continue;
    groups.push({ key: key || "no-product", product: null, title: rows[0]?.productTitle ?? "No product", variants: rows });
  }
  return groups;
}

function CatalogList({
  connectionId,
  products,
  variants,
  moreProducts,
  onProductSaved,
  onVariantSaved,
}: {
  connectionId: ConnectionId;
  products: ProductRow[];
  variants: VariantRow[];
  moreProducts: boolean;
  onProductSaved: (productId: string, binding: ProductBinding | null) => void;
  onVariantSaved: (variantId: string, binding: VariantBinding | null) => void;
}) {
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, { includeArchived: true });
  const groups = groupCatalog(products, variants);

  return (
    <ul>
      {groups.map((group) => (
        <li key={group.key} className="border-b border-border last:border-b-0">
          {group.product ? (
            <ProductLine
              connectionId={connectionId}
              product={group.product}
              programs={programs}
              onSaved={onProductSaved}
            />
          ) : (
            <div className="flex min-h-11 flex-col justify-center px-4 py-2">
              <p className="text-sm font-medium break-words" translate="no">
                {group.title}
              </p>
              <NoteLine>
                {moreProducts ? "Load more to set this product's program." : "This product isn't in the product list."}
              </NoteLine>
            </div>
          )}
          {group.variants.length > 0 ? (
            <ul aria-label={`Prices for ${group.title}`} className="border-t border-border bg-background/60">
              {group.variants.map((variant) => (
                <VariantLine key={variant.variantId} connectionId={connectionId} variant={variant} onSaved={onVariantSaved} />
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

type Programs = FunctionReturnType<typeof api.tenantPrograms.queries.listPrograms> | undefined;

function visibilityNote(visibility: string | null) {
  return visibility && visibility !== "visible" ? visibility.replaceAll("_", " ") : null;
}

function ProductLine({
  connectionId,
  product,
  programs,
  onSaved,
}: {
  connectionId: ConnectionId;
  product: ProductRow;
  programs: Programs;
  onSaved: (productId: string, binding: ProductBinding | null) => void;
}) {
  const setProgram = useMutation(api.payments.bindings.setProductProgram);
  const removeBinding = useMutation(api.payments.bindings.removeBinding);
  const [busy, setBusy] = useState(false);
  const binding = product.binding;
  const hidden = visibilityNote(product.visibility);
  const options = (programs ?? []).filter(
    (program) => program.archivedAt === undefined || program._id === binding?.programId,
  );

  async function choose(value: string) {
    const programId = value as Id<"tenantPrograms">;
    if (programId === binding?.programId) return;
    setBusy(true);
    try {
      const bindingId = await setProgram({ connectionId, productId: product.productId, programId, externalTitle: product.title });
      onSaved(product.productId, { bindingId, programId });
      toast.success(`Program saved for ${product.title}.`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not save the program."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!binding) return;
    setBusy(true);
    try {
      await removeBinding({ bindingId: binding.bindingId });
      onSaved(product.productId, null);
      toast.success(`Program removed from ${product.title}.`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not remove the program."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium break-words" translate="no">
          {product.title}
        </p>
        <p className="truncate text-[12px] text-muted-foreground">
          <span translate="no" className="font-mono">
            {product.productId}
          </span>
          {hidden ? ` · ${hidden}` : null}
        </p>
      </div>
      <div className="flex max-w-full items-center gap-1.5">
        {programs === undefined ? (
          <Skeleton className="h-7 w-44" />
        ) : options.length === 0 ? (
          <NoteLine>No programs yet. Add one in Booking setup.</NoteLine>
        ) : (
          <Select disabled={busy} value={binding?.programId ?? ""} onValueChange={(value) => void choose(value)}>
            <SelectTrigger size="sm" className="w-44 max-w-full" aria-label={`Program for ${product.title}`}>
              <SelectValue placeholder="Not mapped" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {options.map((program) => (
                  <SelectItem key={program._id} value={program._id}>
                    {program.archivedAt === undefined ? program.name : `${program.name} (archived)`}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        <RemoveButton visible={binding !== null} busy={busy} label={`Remove program from ${product.title}`} onClick={remove} />
      </div>
    </div>
  );
}

/** "$1,500.00 one time, split into 3 payments", "$97.00 first, then $497.00 every 30 days". */
function priceFacts(variant: VariantRow) {
  const money = (amount: number) => formatCurrency(amount, variant.currency);
  const parts: string[] = [];
  if (variant.billingType === "one_time") {
    parts.push(`${money(variant.initialPrice)} one time`);
  } else {
    const days = variant.billingPeriodDays;
    const every = days ? (days === 1 ? "every day" : `every ${days} days`) : "recurring";
    parts.push(
      variant.initialPrice > 0 && variant.initialPrice !== variant.renewalPrice
        ? `${money(variant.initialPrice)} first, then ${money(variant.renewalPrice)} ${every}`
        : `${money(variant.renewalPrice)} ${every}`,
    );
  }
  if (variant.splitPayRequiredPayments && variant.splitPayRequiredPayments > 1) {
    parts.push(`split into ${variant.splitPayRequiredPayments} payments`);
  }
  return parts.join(", ");
}

function VariantLine({
  connectionId,
  variant,
  onSaved,
}: {
  connectionId: ConnectionId;
  variant: VariantRow;
  onSaved: (variantId: string, binding: VariantBinding | null) => void;
}) {
  const setType = useMutation(api.payments.bindings.setVariantType);
  const removeBinding = useMutation(api.payments.bindings.removeBinding);
  const [busy, setBusy] = useState(false);
  const binding = variant.binding;
  const title = variant.title ?? "Untitled price";
  const hidden = visibilityNote(variant.visibility);

  async function save(paymentType: PaymentType, laterPaymentType: PaymentType | undefined) {
    if (paymentType === binding?.paymentType && laterPaymentType === binding?.laterPaymentType) return;
    setBusy(true);
    try {
      const bindingId = await setType({
        connectionId,
        variantId: variant.variantId,
        paymentType,
        laterPaymentType,
        externalTitle: variant.title ?? undefined,
      });
      onSaved(variant.variantId, { bindingId, paymentType, laterPaymentType });
      toast.success(`Payment type saved for ${title}.`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not save the payment type."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!binding) return;
    setBusy(true);
    try {
      await removeBinding({ bindingId: binding.bindingId });
      onSaved(variant.variantId, null);
      toast.success(`Payment type removed from ${title}.`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not remove the payment type."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border py-2 pr-4 pl-7 last:border-b-0">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm break-words" translate="no">
          {title}
        </p>
        <p className="text-[13px] leading-[1.4] text-muted-foreground">
          <span className="font-condensed text-[14px] font-semibold text-foreground tabular-nums">
            {priceFacts(variant)}
          </span>
          {hidden ? ` · ${hidden}` : null}
        </p>
        <p className="truncate font-mono text-[12px] text-muted-foreground" translate="no">
          {variant.variantId}
        </p>
      </div>
      <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
        <Select
          disabled={busy}
          value={binding?.paymentType ?? ""}
          onValueChange={(value) => {
            const paymentType = value as PaymentType;
            void save(paymentType, paymentType === "deposit" ? binding?.laterPaymentType : undefined);
          }}
        >
          <SelectTrigger size="sm" className="w-36 max-w-full" aria-label={`Payment type for ${title}`}>
            <SelectValue placeholder="Not mapped" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {PAYMENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {PAYMENT_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {binding?.paymentType === "deposit" ? (
          <Select
            disabled={busy}
            value={binding.laterPaymentType ?? LATER_NONE}
            onValueChange={(value) =>
              void save("deposit", value === LATER_NONE ? undefined : (value as PaymentType))
            }
          >
            <SelectTrigger
              size="sm"
              className={cn("w-40 max-w-full", !binding.laterPaymentType && "text-muted-foreground")}
              aria-label={`Later payments for ${title}`}
            >
              <span className="text-muted-foreground">Later:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={LATER_NONE}>Not set</SelectItem>
                {LATER_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {PAYMENT_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
        <RemoveButton visible={binding !== null} busy={busy} label={`Remove payment type from ${title}`} onClick={remove} />
      </div>
    </li>
  );
}

/** Ghost "Remove" (or "Saving" while a change saves), kept in the layout while hidden so the pickers line up down the column. */
function RemoveButton({
  visible,
  busy,
  label,
  onClick,
}: {
  visible: boolean;
  busy: boolean;
  label: string;
  onClick: () => Promise<void>;
}) {
  const shown = visible || busy;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={busy ? undefined : label}
      disabled={busy || !visible}
      aria-hidden={shown ? undefined : true}
      tabIndex={shown ? undefined : -1}
      className={cn("w-[4.5rem]", !shown && "invisible")}
      onClick={() => void onClick()}
    >
      {busy ? <Spinner data-icon="inline-start" /> : null}
      <TranslatableText>{busy ? "Saving" : "Remove"}</TranslatableText>
    </Button>
  );
}
