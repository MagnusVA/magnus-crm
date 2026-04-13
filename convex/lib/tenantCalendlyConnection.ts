import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type DbReaderCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type DbWriterCtx = Pick<MutationCtx, "db">;

type StoredCalendlyConnection = Doc<"tenantCalendlyConnections">;
type StoredCalendlyConnectionStatus =
  StoredCalendlyConnection["connectionStatus"];

export type TenantCalendlyConnectionState = {
  connectionId: Id<"tenantCalendlyConnections"> | null;
  tenantId: Id<"tenants">;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  refreshLockUntil?: number;
  lastRefreshedAt?: number;
  pkceVerifier?: string;
  organizationUri?: string;
  userUri?: string;
  webhookUri?: string;
  webhookSecret?: string;
  connectionStatus?: StoredCalendlyConnectionStatus;
  lastHealthCheckAt?: number;
  webhookProvisioningStartedAt?: number;
};

export type TenantCalendlyConnectionPatch = {
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
  tokenExpiresAt?: number | undefined;
  refreshLockUntil?: number | undefined;
  lastRefreshedAt?: number | undefined;
  pkceVerifier?: string | undefined;
  organizationUri?: string | undefined;
  userUri?: string | undefined;
  webhookUri?: string | undefined;
  webhookSecret?: string | undefined;
  connectionStatus?: StoredCalendlyConnectionStatus | undefined;
  lastHealthCheckAt?: number | undefined;
  webhookProvisioningStartedAt?: number | undefined;
};

function getLegacyStringField(
  row: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = row[field];
  return typeof value === "string" ? value : undefined;
}

function getLegacyNumberField(
  row: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getLegacyTenantCalendlyConnectionPatch(
  tenant: Doc<"tenants">,
): TenantCalendlyConnectionPatch | null {
  const rawTenant = tenant as Record<string, unknown>;
  const patch: TenantCalendlyConnectionPatch = {};

  const accessToken = getLegacyStringField(rawTenant, "calendlyAccessToken");
  const refreshToken = getLegacyStringField(rawTenant, "calendlyRefreshToken");
  const tokenExpiresAt = getLegacyNumberField(rawTenant, "calendlyTokenExpiresAt");
  const refreshLockUntil = getLegacyNumberField(
    rawTenant,
    "calendlyRefreshLockUntil",
  );
  const lastRefreshedAt = getLegacyNumberField(rawTenant, "lastTokenRefreshAt");
  const pkceVerifier = getLegacyStringField(rawTenant, "codeVerifier");
  const organizationUri = getLegacyStringField(rawTenant, "calendlyOrgUri");
  const userUri = getLegacyStringField(rawTenant, "calendlyOwnerUri");
  const webhookUri = getLegacyStringField(rawTenant, "calendlyWebhookUri");
  const webhookSecret = getLegacyStringField(rawTenant, "webhookSigningKey");
  const webhookProvisioningStartedAt = getLegacyNumberField(
    rawTenant,
    "webhookProvisioningStartedAt",
  );

  if (accessToken !== undefined) {
    patch.accessToken = accessToken;
  }
  if (refreshToken !== undefined) {
    patch.refreshToken = refreshToken;
  }
  if (tokenExpiresAt !== undefined) {
    patch.tokenExpiresAt = tokenExpiresAt;
  }
  if (refreshLockUntil !== undefined) {
    patch.refreshLockUntil = refreshLockUntil;
  }
  if (lastRefreshedAt !== undefined) {
    patch.lastRefreshedAt = lastRefreshedAt;
  }
  if (pkceVerifier !== undefined) {
    patch.pkceVerifier = pkceVerifier;
  }
  if (organizationUri !== undefined) {
    patch.organizationUri = organizationUri;
  }
  if (userUri !== undefined) {
    patch.userUri = userUri;
  }
  if (webhookUri !== undefined) {
    patch.webhookUri = webhookUri;
  }
  if (webhookSecret !== undefined) {
    patch.webhookSecret = webhookSecret;
  }
  if (webhookProvisioningStartedAt !== undefined) {
    patch.webhookProvisioningStartedAt = webhookProvisioningStartedAt;
  }

  if (Object.keys(patch).length === 0) {
    return null;
  }

  patch.connectionStatus = deriveConnectionStatus({
    accessToken: patch.accessToken,
    refreshToken: patch.refreshToken,
    connectionStatus: undefined,
  });

  return patch;
}

function deriveConnectionStatus(
  state: Pick<
    TenantCalendlyConnectionState,
    "accessToken" | "connectionStatus" | "refreshToken"
  >,
): StoredCalendlyConnectionStatus {
  if (state.connectionStatus) {
    return state.connectionStatus;
  }

  return state.accessToken || state.refreshToken
    ? "connected"
    : "disconnected";
}

function mapStoredConnection(
  connection: StoredCalendlyConnection,
): TenantCalendlyConnectionState {
  return {
    connectionId: connection._id,
    tenantId: connection.tenantId,
    accessToken: connection.calendlyAccessToken,
    refreshToken: connection.calendlyRefreshToken,
    tokenExpiresAt: connection.calendlyTokenExpiresAt,
    refreshLockUntil: connection.calendlyRefreshLockUntil,
    lastRefreshedAt: connection.lastTokenRefreshAt,
    pkceVerifier: connection.codeVerifier,
    organizationUri: connection.calendlyOrganizationUri,
    userUri: connection.calendlyUserUri,
    webhookUri: connection.calendlyWebhookUri,
    webhookSecret: connection.calendlyWebhookSigningKey,
    connectionStatus: deriveConnectionStatus({
      accessToken: connection.calendlyAccessToken,
      refreshToken: connection.calendlyRefreshToken,
      connectionStatus: connection.connectionStatus,
    }),
    lastHealthCheckAt: connection.lastHealthCheckAt,
    webhookProvisioningStartedAt: connection.webhookProvisioningStartedAt,
  };
}

export function toStoredPatch(
  patch: TenantCalendlyConnectionPatch,
): Partial<StoredCalendlyConnection> {
  const storedPatch: Partial<StoredCalendlyConnection> = {};

  if ("accessToken" in patch) {
    storedPatch.calendlyAccessToken = patch.accessToken;
  }
  if ("refreshToken" in patch) {
    storedPatch.calendlyRefreshToken = patch.refreshToken;
  }
  if ("tokenExpiresAt" in patch) {
    storedPatch.calendlyTokenExpiresAt = patch.tokenExpiresAt;
  }
  if ("refreshLockUntil" in patch) {
    storedPatch.calendlyRefreshLockUntil = patch.refreshLockUntil;
  }
  if ("lastRefreshedAt" in patch) {
    storedPatch.lastTokenRefreshAt = patch.lastRefreshedAt;
  }
  if ("pkceVerifier" in patch) {
    storedPatch.codeVerifier = patch.pkceVerifier;
  }
  if ("organizationUri" in patch) {
    storedPatch.calendlyOrganizationUri = patch.organizationUri;
  }
  if ("userUri" in patch) {
    storedPatch.calendlyUserUri = patch.userUri;
  }
  if ("webhookUri" in patch) {
    storedPatch.calendlyWebhookUri = patch.webhookUri;
  }
  if ("webhookSecret" in patch) {
    storedPatch.calendlyWebhookSigningKey = patch.webhookSecret;
  }
  if ("connectionStatus" in patch) {
    storedPatch.connectionStatus = patch.connectionStatus;
  }
  if ("lastHealthCheckAt" in patch) {
    storedPatch.lastHealthCheckAt = patch.lastHealthCheckAt;
  }
  if ("webhookProvisioningStartedAt" in patch) {
    storedPatch.webhookProvisioningStartedAt =
      patch.webhookProvisioningStartedAt;
  }

  return storedPatch;
}

export async function getStoredTenantCalendlyConnection(
  ctx: DbReaderCtx,
  tenantId: Id<"tenants">,
): Promise<StoredCalendlyConnection | null> {
  return await ctx.db
    .query("tenantCalendlyConnections")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .first();
}

export async function getTenantCalendlyConnectionState(
  ctx: DbReaderCtx,
  tenantId: Id<"tenants">,
): Promise<TenantCalendlyConnectionState | null> {
  const storedConnection = await getStoredTenantCalendlyConnection(ctx, tenantId);
  return storedConnection ? mapStoredConnection(storedConnection) : null;
}

export async function requireTenantCalendlyConnectionState(
  ctx: DbReaderCtx,
  tenantId: Id<"tenants">,
): Promise<TenantCalendlyConnectionState> {
  const connectionState = await getTenantCalendlyConnectionState(ctx, tenantId);
  if (!connectionState) {
    throw new Error(`Tenant ${tenantId} not found`);
  }
  return connectionState;
}

export async function ensureTenantCalendlyConnection(
  ctx: DbWriterCtx,
  tenantId: Id<"tenants">,
): Promise<StoredCalendlyConnection> {
  const existing = await getStoredTenantCalendlyConnection(ctx, tenantId);
  if (existing) {
    return existing;
  }

  const tenant = await ctx.db.get(tenantId);
  if (!tenant) {
    throw new Error("Tenant not found");
  }

  const legacyPatch = getLegacyTenantCalendlyConnectionPatch(tenant);
  const connectionId = await ctx.db.insert("tenantCalendlyConnections", {
    tenantId,
    ...toStoredPatch(legacyPatch ?? {}),
    connectionStatus:
      legacyPatch?.connectionStatus ??
      deriveConnectionStatus({
        accessToken: legacyPatch?.accessToken,
        refreshToken: legacyPatch?.refreshToken,
        connectionStatus: legacyPatch?.connectionStatus,
      }),
  });

  const created = await ctx.db.get(connectionId);
  if (!created) {
    throw new Error("Failed to create tenant Calendly connection");
  }

  return created;
}

export async function updateTenantCalendlyConnection(
  ctx: DbWriterCtx,
  tenantId: Id<"tenants">,
  patch: TenantCalendlyConnectionPatch,
): Promise<void> {
  const storedPatch = toStoredPatch(patch);
  if (Object.keys(storedPatch).length === 0) {
    return;
  }

  const connection = await ensureTenantCalendlyConnection(ctx, tenantId);
  await ctx.db.patch(connection._id, storedPatch);
}
