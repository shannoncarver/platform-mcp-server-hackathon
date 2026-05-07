// Fine-grained user permissions store.
//
// Reads `platform_mcp_user_permissions[user_email]` from DynamoDB. An
// in-process LRU cache (5-min TTL) absorbs hot-path reads. The store is
// pluggable so tests can substitute an in-memory implementation.

import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { UserPermissions } from "./types.js";

const TABLE_NAME =
  process.env.USER_PERMISSIONS_TABLE_NAME ?? "platform_mcp_user_permissions";
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1024;

interface CacheEntry {
  value: UserPermissions | null;
  expiresAtMs: number;
}

const cache = new Map<string, CacheEntry>();

let docClient: DynamoDBDocumentClient | undefined;

function getClient(): DynamoDBDocumentClient {
  if (docClient === undefined) {
    const cfg: DynamoDBClientConfig = {};
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient(cfg));
  }
  return docClient;
}

export interface PermissionsStore {
  load(userEmail: string): Promise<UserPermissions | undefined>;
}

export const ddbPermissionsStore: PermissionsStore = {
  async load(userEmail: string): Promise<UserPermissions | undefined> {
    const nowMs = Date.now();
    const cached = cache.get(userEmail);
    if (cached !== undefined && cached.expiresAtMs > nowMs) {
      return cached.value ?? undefined;
    }

    const result = await getClient().send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { user_email: userEmail },
        ConsistentRead: false,
      }),
    );
    const item = result.Item;
    if (item === undefined) {
      cache.set(userEmail, { value: null, expiresAtMs: nowMs + CACHE_TTL_MS });
      pruneCacheIfNeeded();
      return undefined;
    }

    // DocumentClient unmarshalls SS to a JS Set — preserve that.
    const permissions: Set<string> =
      item.permissions instanceof Set
        ? (item.permissions as Set<string>)
        : new Set<string>(item.permissions ?? []);

    const value: UserPermissions = {
      user_email: item.user_email,
      permissions,
      tenant_id: item.tenant_id,
      last_modified_at: item.last_modified_at ?? new Date().toISOString(),
      last_modified_by: item.last_modified_by,
    };
    cache.set(userEmail, { value, expiresAtMs: nowMs + CACHE_TTL_MS });
    pruneCacheIfNeeded();
    return value;
  },
};

function pruneCacheIfNeeded(): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  // Drop the entries with the oldest expiry.
  const entries = Array.from(cache.entries()).sort(
    (a, b) => a[1].expiresAtMs - b[1].expiresAtMs,
  );
  while (cache.size > CACHE_MAX_ENTRIES) {
    const [k] = entries.shift() ?? [];
    if (k === undefined) break;
    cache.delete(k);
  }
}

let activeStore: PermissionsStore = ddbPermissionsStore;

export function setPermissionsStore(store: PermissionsStore): void {
  activeStore = store;
}

export async function loadPermissions(
  userEmail: string,
): Promise<UserPermissions | undefined> {
  return activeStore.load(userEmail);
}

/** Test-only: clear the cache between cases. */
export function _resetCacheForTesting(): void {
  cache.clear();
}
