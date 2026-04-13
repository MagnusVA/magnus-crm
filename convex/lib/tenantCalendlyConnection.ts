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
};

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
  };
}

function mapTenantFallback(
  tenant: Doc<"tenants">,
): TenantCalendlyConnectionState {
  return {
    connectionId: null,
    tenantId: tenant._id,
    accessToken: tenant.calendlyAccessToken,
    refreshToken: tenant.calendlyRefreshToken,
    tokenExpiresAt: tenant.calendlyTokenExpiresAt,
    refreshLockUntil: tenant.calendlyRefreshLockUntil,
    lastRefreshedAt: tenant.lastTokenRefreshAt,
    pkceVerifier: tenant.codeVerifier,
    organizationUri: tenant.calendlyOrgUri,
    userUri: tenant.calendlyOwnerUri,
    webhookUri: tenant.calendlyWebhookUri,
    webhookSecret: tenant.webhookSigningKey,
    connectionStatus:
      tenant.calendlyAccessToken || tenant.calendlyRefreshToken
        ? "connected"
        : "disconnected",
    lastHealthCheckAt: undefined,
  };
}

function mergeConnectionState(
  primary: TenantCalendlyConnectionState,
  fallback: TenantCalendlyConnectionState,
): TenantCalendlyConnectionState {
  return {
    connectionId: primary.connectionId,
    tenantId: primary.tenantId,
    accessToken: primary.accessToken ?? fallback.accessToken,
    refreshToken: primary.refreshToken ?? fallback.refreshToken,
    tokenExpiresAt: primary.tokenExpiresAt ?? fallback.tokenExpiresAt,
    refreshLockUntil: primary.refreshLockUntil ?? fallback.refreshLockUntil,
    lastRefreshedAt: primary.lastRefreshedAt ?? fallback.lastRefreshedAt,
    pkceVerifier: primary.pkceVerifier ?? fallback.pkceVerifier,
    organizationUri: primary.organizationUri ?? fallback.organizationUri,
    userUri: primary.userUri ?? fallback.userUri,
    webhookUri: primary.webhookUri ?? fallback.webhookUri,
    webhookSecret: primary.webhookSecret ?? fallback.webhookSecret,
    connectionStatus: deriveConnectionStatus({
      accessToken: primary.accessToken ?? fallback.accessToken,
      refreshToken: primary.refreshToken ?? fallback.refreshToken,
      connectionStatus: primary.connectionStatus ?? fallback.connectionStatus,
    }),
    lastHealthCheckAt: primary.lastHealthCheckAt ?? fallback.lastHealthCheckAt,
  };
}

function shouldReadTenantFallback(
  connection: TenantCalendlyConnectionState,
): boolean {
  return (
    connection.accessToken === undefined ||
    connection.refreshToken === undefined ||
    connection.tokenExpiresAt === undefined ||
    connection.refreshLockUntil === undefined ||
    connection.lastRefreshedAt === undefined ||
    connection.pkceVerifier === undefined ||
    connection.organizationUri === undefined ||
    connection.userUri === undefined ||
    connection.webhookUri === undefined ||
    connection.webhookSecret === undefined
  );
}

function toStoredPatch(
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
  if (!storedConnection) {
    const tenant = await ctx.db.get(tenantId);
    return tenant ? mapTenantFallback(tenant) : null;
  }

  const connectionState = mapStoredConnection(storedConnection);
  if (!shouldReadTenantFallback(connectionState)) {
    return connectionState;
  }

  const tenant = await ctx.db.get(tenantId);
  if (!tenant) {
    return connectionState;
  }

  return mergeConnectionState(connectionState, mapTenantFallback(tenant));
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

  const connectionId = await ctx.db.insert("tenantCalendlyConnections", {
    tenantId,
    calendlyAccessToken: tenant.calendlyAccessToken,
    calendlyRefreshToken: tenant.calendlyRefreshToken,
    calendlyTokenExpiresAt: tenant.calendlyTokenExpiresAt,
    calendlyRefreshLockUntil: tenant.calendlyRefreshLockUntil,
    lastTokenRefreshAt: tenant.lastTokenRefreshAt,
    codeVerifier: tenant.codeVerifier,
    calendlyOrganizationUri: tenant.calendlyOrgUri,
    calendlyUserUri: tenant.calendlyOwnerUri,
    calendlyWebhookUri: tenant.calendlyWebhookUri,
    calendlyWebhookSigningKey: tenant.webhookSigningKey,
    connectionStatus:
      tenant.calendlyAccessToken || tenant.calendlyRefreshToken
        ? "connected"
        : "disconnected",
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
  const connection = await ensureTenantCalendlyConnection(ctx, tenantId);
  const storedPatch = toStoredPatch(patch);
  if (Object.keys(storedPatch).length === 0) {
    return;
  }

  await ctx.db.patch(connection._id, storedPatch);
}
