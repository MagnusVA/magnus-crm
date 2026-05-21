"use node";

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import type { CrmRole } from "../lib/roleMapping";
import { issuePortalSessionToken } from "./sessionToken";

const HASH_PARAMS = {
  algorithm: "scrypt" as const,
  keyLength: 32,
  N: 32768,
  r: 8,
  p: 1,
};
const SCRYPT_MAXMEM_BYTES = 64 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const MAX_PORTAL_SLUG_LENGTH = 128;
const GENERIC_PORTAL_AUTH_ERROR = "Portal unavailable or password invalid.";
const IP_HASH_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type HashParams = typeof HASH_PARAMS;
type TenantAdminPortalAccess = {
  tenantId: Id<"tenants">;
  userId: Id<"users">;
  role: CrmRole;
};
type LinkPortalConfigForPassword = {
  tenantId: Id<"tenants">;
  publicSlug: string;
  isEnabled: boolean;
  passwordHash?: string;
  passwordSalt?: string;
  passwordHashParams?: HashParams;
  passwordSetAt?: number;
  passwordRotatedAt?: number;
  sessionVersion: number;
  sessionTtlSeconds: number;
};
type PortalPasswordRotationResult = {
  portalUrlPath: string;
  publicSlug: string;
  passwordSetAt?: number;
  passwordRotatedAt?: number;
};
type PortalPasswordVerificationResult = {
  sessionToken: string;
  maxAgeSeconds: number;
};

function scrypt(
  password: string,
  salt: string,
  keyLength: number,
  options: ScryptOptions,
) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(derivedKey));
    });
  });
}

function randomPortalSlug() {
  return `lp_${randomBytes(18).toString("base64url")}`;
}

function isSlugCollision(error: unknown) {
  return error instanceof Error && error.message.includes("Portal slug collision");
}

async function hashPortalPassword(
  password: string,
  salt: string,
  hashParams: HashParams,
) {
  const pepper = process.env.LINK_PORTAL_PASSWORD_PEPPER ?? "";
  const derived = (await scrypt(
    `${password}${pepper}`,
    salt,
    hashParams.keyLength,
    {
      N: hashParams.N,
      r: hashParams.r,
      p: hashParams.p,
      maxmem: SCRYPT_MAXMEM_BYTES,
    },
  )) as Buffer;
  return derived.toString("base64url");
}

function normalizePortalSlug(portalSlug: string) {
  const trimmed = portalSlug.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PORTAL_SLUG_LENGTH) {
    throw new Error(GENERIC_PORTAL_AUTH_ERROR);
  }
  return trimmed;
}

function normalizeIpHash(ipHash: string) {
  const trimmed = ipHash.trim();
  if (!IP_HASH_PATTERN.test(trimmed)) {
    throw new Error(GENERIC_PORTAL_AUTH_ERROR);
  }
  return trimmed;
}

function isSubmittedPasswordAllowed(password: string) {
  return (
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}

function assertAdminSetPasswordAllowed(password: string) {
  if (!isSubmittedPasswordAllowed(password)) {
    throw new Error(
      `Portal password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
}

function isSupportedHashParams(
  value: HashParams | undefined,
): value is HashParams {
  return (
    value?.algorithm === HASH_PARAMS.algorithm &&
    value.keyLength === HASH_PARAMS.keyLength &&
    value.N === HASH_PARAMS.N &&
    value.r === HASH_PARAMS.r &&
    value.p === HASH_PARAMS.p
  );
}

export const rotatePortalPassword = action({
  args: {
    password: v.string(),
  },
  handler: async (ctx, args): Promise<PortalPasswordRotationResult> => {
    const access: TenantAdminPortalAccess = await ctx.runQuery(
      internal.linkPortal.authz.requireTenantAdminForPortal,
      {},
    );
    assertAdminSetPasswordAllowed(args.password);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const passwordSalt = randomBytes(16).toString("base64url");
      const passwordHash = await hashPortalPassword(
        args.password,
        passwordSalt,
        HASH_PARAMS,
      );

      try {
        const config: LinkPortalConfigForPassword | null = await ctx.runMutation(
          internal.linkPortal.configMutations.rotatePasswordHash,
          {
            tenantId: access.tenantId,
            publicSlug: randomPortalSlug(),
            passwordHash,
            passwordSalt,
            passwordHashParams: HASH_PARAMS,
          },
        );
        if (!config) {
          throw new Error("Portal configuration could not be saved.");
        }

        return {
          portalUrlPath: `/dm-links/${config.publicSlug}`,
          publicSlug: config.publicSlug,
          passwordSetAt: config.passwordSetAt,
          passwordRotatedAt: config.passwordRotatedAt,
        };
      } catch (error) {
        if (!isSlugCollision(error) || attempt === 2) {
          throw error;
        }
      }
    }

    throw new Error("Portal configuration could not be saved.");
  },
});

export const verifyPassword = action({
  args: {
    portalSlug: v.string(),
    password: v.string(),
    ipHash: v.string(),
  },
  handler: async (ctx, args): Promise<PortalPasswordVerificationResult> => {
    const portalSlug = normalizePortalSlug(args.portalSlug);
    const ipHash = normalizeIpHash(args.ipHash);

    const config: LinkPortalConfigForPassword | null = await ctx.runQuery(
      internal.linkPortal.configQueries.getConfigByPublicSlug,
      { publicSlug: portalSlug },
    );
    if (
      !config ||
      !config.isEnabled ||
      !config.passwordHash ||
      !config.passwordSalt ||
      !isSupportedHashParams(config.passwordHashParams)
    ) {
      throw new Error(GENERIC_PORTAL_AUTH_ERROR);
    }

    await ctx.runMutation(internal.linkPortal.rateLimitMutations.assertNotLocked, {
      tenantId: config.tenantId,
      publicSlug: portalSlug,
      ipHash,
    });

    if (!isSubmittedPasswordAllowed(args.password)) {
      await ctx.runMutation(
        internal.linkPortal.rateLimitMutations.recordFailedAttempt,
        {
          tenantId: config.tenantId,
          publicSlug: portalSlug,
          ipHash,
        },
      );
      throw new Error(GENERIC_PORTAL_AUTH_ERROR);
    }

    const attemptedHash = await hashPortalPassword(
      args.password,
      config.passwordSalt,
      config.passwordHashParams,
    );
    const attemptedBuffer = Buffer.from(attemptedHash, "base64url");
    const expectedBuffer = Buffer.from(config.passwordHash, "base64url");
    const valid =
      attemptedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(attemptedBuffer, expectedBuffer);

    if (!valid) {
      await ctx.runMutation(
        internal.linkPortal.rateLimitMutations.recordFailedAttempt,
        {
          tenantId: config.tenantId,
          publicSlug: portalSlug,
          ipHash,
        },
      );
      throw new Error(GENERIC_PORTAL_AUTH_ERROR);
    }

    await ctx.runMutation(
      internal.linkPortal.rateLimitMutations.clearFailedAttempts,
      {
        tenantId: config.tenantId,
        ipHash,
      },
    );

    return {
      sessionToken: issuePortalSessionToken({
        tenantId: config.tenantId,
        publicSlug: config.publicSlug,
        sessionVersion: config.sessionVersion,
        ttlSeconds: config.sessionTtlSeconds,
      }),
      maxAgeSeconds: config.sessionTtlSeconds,
    };
  },
});
