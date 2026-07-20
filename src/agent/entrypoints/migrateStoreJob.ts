// Phase 2 cutover tool (docs/platform/DIRECTION.md): copies every key from the Netlify Blobs
// store to the GCS bucket, and verifies the copy. Idempotent — re-running overwrites destination
// keys with current source values, so an aborted migration is simply re-run. The intended
// procedure (freeze writes → migrate → verify → flip WORKSPACE_STORE=gcs → unfreeze) lives in
// docs/platform/PHASE2_RUNBOOK.md; rollback during the window is flipping the env back.
import { getStore } from "@netlify/blobs";
import type { BlobStoreClient } from "../repository/blobs/blobClient.js";
import { createGcsStoreClient } from "../repository/gcs/gcsStoreClient.js";

const DEFAULT_CONCURRENCY = 16;

export type MigrateStoreOptions = {
  prefix?: string;
  dryRun?: boolean;
  concurrency?: number;
  log?: (line: string) => void;
  /** Injectable for tests; defaults are the real Netlify (source) and GCS (target) clients. */
  source?: BlobStoreClient;
  target?: BlobStoreClient;
};

export type MigrateStoreResult = {
  mode: "dry_run" | "migrate";
  keys: number;
  copied: number;
  skipped: number;
  byPrefix: Record<string, number>;
};

export type VerifyStoreResult = {
  keys: number;
  matched: number;
  mismatched: string[];
  missingInTarget: string[];
};

// The migration always reads Netlify Blobs explicitly (never the env-selected store): during the
// cutover WORKSPACE_STORE may already be flipped to gcs, and the source must stay the old store.
const netlifySourceStore = (): BlobStoreClient => {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID?.trim();
  const token = process.env.NETLIFY_BLOBS_TOKEN?.trim();
  if (!siteID || !token) throw new Error("Migration requires NETLIFY_BLOBS_SITE_ID and NETLIFY_BLOBS_TOKEN (source store).");
  return getStore({ name: process.env.NETLIFY_BLOBS_STORE_NAME ?? "cms-agent", siteID, token });
};

const gcsTargetStore = (): BlobStoreClient => createGcsStoreClient() as unknown as BlobStoreClient;

const topPrefix = (key: string): string => key.split("/")[0] ?? key;

async function inBatches<T>(items: T[], size: number, task: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(task));
  }
}

export async function migrateStore(options: MigrateStoreOptions = {}): Promise<MigrateStoreResult> {
  const log = options.log ?? (() => undefined);
  const source = options.source ?? netlifySourceStore();
  const target = options.target ?? gcsTargetStore();
  const { blobs } = await source.list({ prefix: options.prefix ?? "" });
  const byPrefix: Record<string, number> = {};
  for (const blob of blobs) byPrefix[topPrefix(blob.key)] = (byPrefix[topPrefix(blob.key)] ?? 0) + 1;
  log(`Source store lists ${blobs.length} key(s)${options.prefix ? ` under "${options.prefix}"` : ""}: ${Object.entries(byPrefix).map(([prefix, count]) => `${prefix}=${count}`).join(", ") || "none"}`);
  if (options.dryRun) return { mode: "dry_run", keys: blobs.length, copied: 0, skipped: 0, byPrefix };

  let copied = 0;
  let skipped = 0;
  await inBatches(blobs, Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY), async (blob) => {
    const value = await source.get(blob.key, { type: "json" });
    if (value === null) {
      // Deleted between list and read — nothing to copy.
      skipped += 1;
      return;
    }
    await target.setJSON(blob.key, value);
    copied += 1;
  });
  log(`Copied ${copied} key(s), skipped ${skipped}.`);
  return { mode: "migrate", keys: blobs.length, copied, skipped, byPrefix };
}

// Full-fidelity check: every source key must exist in the target with identical JSON. Run after
// migrate and before flipping WORKSPACE_STORE. (Comparison is on serialized JSON; both sides come
// from JSON round-trips of the same objects, so key order is stable.)
export async function verifyStore(options: MigrateStoreOptions = {}): Promise<VerifyStoreResult> {
  const log = options.log ?? (() => undefined);
  const source = options.source ?? netlifySourceStore();
  const target = options.target ?? gcsTargetStore();
  const { blobs } = await source.list({ prefix: options.prefix ?? "" });
  let matched = 0;
  const mismatched: string[] = [];
  const missingInTarget: string[] = [];
  await inBatches(blobs, Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY), async (blob) => {
    const [sourceValue, targetValue] = await Promise.all([
      source.get(blob.key, { type: "json" }),
      target.get(blob.key, { type: "json" })
    ]);
    if (sourceValue === null) { matched += 1; return; } // deleted after listing; nothing to require
    if (targetValue === null) { missingInTarget.push(blob.key); return; }
    if (JSON.stringify(sourceValue) === JSON.stringify(targetValue)) matched += 1;
    else mismatched.push(blob.key);
  });
  log(`Verify: ${matched}/${blobs.length} matched, ${missingInTarget.length} missing, ${mismatched.length} mismatched.`);
  return { keys: blobs.length, matched, mismatched, missingInTarget };
}

export async function cliMain(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const has = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
  const options: MigrateStoreOptions = {
    prefix: value("prefix") ?? env.MIGRATE_PREFIX ?? undefined,
    dryRun: has("dry-run"),
    concurrency: value("concurrency") ? Number.parseInt(value("concurrency")!, 10) : undefined,
    log: (line) => console.error(line)
  };
  if (has("verify")) {
    const result = await verifyStore(options);
    console.log(JSON.stringify({ action: "verify", ...result }));
    return result.mismatched.length === 0 && result.missingInTarget.length === 0 ? 0 : 1;
  }
  const result = await migrateStore(options);
  console.log(JSON.stringify({ action: "migrate", ...result }));
  return 0;
}
