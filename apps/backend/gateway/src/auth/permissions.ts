/**
 * Merchant-team fine-grained permissions (Issue #383).
 *
 * A merchant team member's JWT carries a `roles` claim and may also carry an
 * explicit `permissions` claim. This module normalises both into the typed
 * `MerchantTeamPermission` set consumed by the permission middleware.
 */

/** Fine-grained permissions a merchant team member can hold. */
export type MerchantTeamPermission =
  | "catalog:write"
  | "orders:manage"
  | "disputes:resolve"
  | "settlement:view";

/** Every permission in canonical evaluation order. */
export const MERCHANT_TEAM_PERMISSIONS: readonly MerchantTeamPermission[] = [
  "catalog:write",
  "orders:manage",
  "disputes:resolve",
  "settlement:view",
];

/** Role claim values mapped to the permissions they grant. */
export const MERCHANT_TEAM_ROLE_PERMISSIONS: Readonly<
  Record<string, readonly MerchantTeamPermission[]>
> = {
  // Platform administrators are treated as super-users for merchant teams.
  admin: MERCHANT_TEAM_PERMISSIONS,
  "merchant:owner": MERCHANT_TEAM_PERMISSIONS,
  "merchant:admin": MERCHANT_TEAM_PERMISSIONS,
  "merchant:manager": ["catalog:write", "orders:manage"],
  "merchant:operator": ["orders:manage"],
  "merchant:dispute": ["disputes:resolve"],
  "merchant:finance": ["settlement:view"],
};

/** JWT claim subset used to resolve merchant-team permissions. */
export interface MerchantTeamClaims {
  roles?: readonly string[];
  permissions?: readonly string[];
}

const PERMISSION_SET: ReadonlySet<string> = new Set(MERCHANT_TEAM_PERMISSIONS);

/** Type guard for a single permission claim value. */
export function isMerchantTeamPermission(value: unknown): value is MerchantTeamPermission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

/**
 * Resolve the effective permission set for a set of JWT claims.
 *
 * Explicit `permissions` claims are validated against the union and merged
 * with the permissions derived from `roles`; unknown claim values are ignored.
 * The wildcard `*` grants every permission. The result is de-duplicated in
 * `MERCHANT_TEAM_PERMISSIONS` order so callers get deterministic output.
 */
export function resolveMerchantTeamPermissions(
  claims: MerchantTeamClaims | undefined | null,
): MerchantTeamPermission[] {
  if (!claims) return [];

  const explicit = claims.permissions ?? [];
  if (explicit.includes("*")) {
    return [...MERCHANT_TEAM_PERMISSIONS];
  }

  const granted = new Set<MerchantTeamPermission>();
  for (const value of explicit) {
    if (isMerchantTeamPermission(value)) granted.add(value);
  }

  for (const role of claims.roles ?? []) {
    const rolePermissions = MERCHANT_TEAM_ROLE_PERMISSIONS[role];
    if (!rolePermissions) continue;
    for (const permission of rolePermissions) granted.add(permission);
  }

  return MERCHANT_TEAM_PERMISSIONS.filter((permission) => granted.has(permission));
}

/** Whether the given claims grant a specific permission. */
export function hasMerchantTeamPermission(
  claims: MerchantTeamClaims | undefined | null,
  permission: MerchantTeamPermission,
): boolean {
  return resolveMerchantTeamPermissions(claims).includes(permission);
}
