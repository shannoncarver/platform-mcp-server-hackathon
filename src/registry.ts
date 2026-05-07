// DynamoDB-backed tool registry with per-user projection.
//
// One DDB row per (toolId, version). `getProjected` filters by
// `requiredPermissions` against the caller's permission set. `getById`
// fetches a specific tool for `tools/call` dispatch. A 5-minute in-process
// cache absorbs hot reads.

import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { RegistryItem } from "./types.js";

const TABLE_NAME =
  process.env.TOOL_REGISTRY_TABLE_NAME ?? "platform_mcp_tool_registry";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface RegistryCache {
  items: RegistryItem[];
  fetchedAtMs: number;
}

let cache: RegistryCache | undefined;
let docClient: DynamoDBDocumentClient | undefined;

function getClient(): DynamoDBDocumentClient {
  if (docClient === undefined) {
    const cfg: DynamoDBClientConfig = {};
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient(cfg));
  }
  return docClient;
}

export interface RegistryStore {
  listAll(): Promise<RegistryItem[]>;
}

export const ddbRegistryStore: RegistryStore = {
  async listAll(): Promise<RegistryItem[]> {
    const result = await getClient().send(
      new ScanCommand({ TableName: TABLE_NAME }),
    );
    return (result.Items ?? []).map((it) => ({
      toolId: it.toolId,
      version: it.version,
      status: it.status,
      description: it.description,
      title: it.title,
      inputSchema: it.inputSchema ?? {},
      outputSchema: it.outputSchema,
      requiredPermissions: it.requiredPermissions ?? [],
      dispatchTarget: it.dispatchTarget,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
    }));
  },
};

let activeStore: RegistryStore = ddbRegistryStore;

export function setRegistryStore(store: RegistryStore): void {
  activeStore = store;
}

async function getAll(): Promise<RegistryItem[]> {
  const nowMs = Date.now();
  if (cache !== undefined && nowMs - cache.fetchedAtMs < CACHE_TTL_MS) {
    return cache.items;
  }
  const items = await activeStore.listAll();
  cache = { items, fetchedAtMs: nowMs };
  return items;
}

export function _invalidateCacheForTesting(): void {
  cache = undefined;
}

/** Per-user projection — filter to tools whose required permissions are satisfied. */
export async function getProjected(
  permissions: ReadonlySet<string>,
): Promise<RegistryItem[]> {
  const all = await getAll();
  return all.filter(
    (it) =>
      it.status === "active" &&
      it.requiredPermissions.every((p) => permissions.has(p)),
  );
}

/**
 * Resolve a tool by ID. The visibility check is a separate concern —
 * `tools/call` calls this to find the row, then checks visibility.
 */
export async function getById(
  toolId: string,
): Promise<RegistryItem | undefined> {
  const all = await getAll();
  return all.find((it) => it.toolId === toolId && it.status === "active");
}

/** Visibility = the same predicate `getProjected` applies. */
export function isVisibleTo(
  item: RegistryItem,
  permissions: ReadonlySet<string>,
): boolean {
  return (
    item.status === "active" &&
    item.requiredPermissions.every((p) => permissions.has(p))
  );
}
