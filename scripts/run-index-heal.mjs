/**
 * W1 — one-off: rewrite every run-index row to the current RUN_INDEX_VERSION.
 *
 * The lazy heal in BlobExecutionRepository.listRunSummariesPage repairs only the rows in the page
 * it is serving, and only when someone asks for that page. A store carrying a version gap across
 * its whole fleet therefore pays `limit` run-blob reads on every listing of every un-visited page
 * until someone visits it. This drains the gap in one pass.
 *
 * DRY RUN BY DEFAULT — it reports what it would rewrite and changes nothing. Pass `--apply` to
 * write. Needs the same environment the service runs with:
 *
 *   WORKSPACE_STORE=gcs GCS_BUCKET=<bucket> [GCS_KEY_PREFIX=<prefix>] \
 *     npx tsx scripts/run-index-heal.mjs [--apply] [--project <projectId>]
 *
 * Reads every run blob named by a stale row, recomputes its summary through the SAME projection
 * the repository uses (runSummaryOf), and writes each project's index once. Rows whose run blob is
 * gone are reported as ghosts and dropped.
 */
import { createGcsStoreClient } from '../src/agent/repository/gcs/gcsStoreClient.ts';
import { getBlobJson, getBlobJsonWithEtag } from '../src/agent/repository/blobs/blobClient.ts';
import { RUN_INDEX_VERSION } from '../src/agent/repository/blobs/BlobExecutionRepository.ts';
import { runSummaryOf } from '../src/agent/repository/interfaces/ExecutionRepository.ts';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY_PROJECT = args.includes('--project') ? args[args.indexOf('--project') + 1] : undefined;

const RUN_INDEX_PREFIX = 'run-index/';
const RUN_INDEX_META_KEY = `${RUN_INDEX_PREFIX}!meta.json`;
const indexKeyOf = (projectId) => `${RUN_INDEX_PREFIX}${encodeURIComponent(projectId)}.json`;

if ((process.env.WORKSPACE_STORE ?? '') !== 'gcs') {
  console.error('WORKSPACE_STORE=gcs is required — this script talks to the live object store.');
  process.exit(2);
}

const store = createGcsStoreClient();

/** Bounded concurrency: a fleet heal must not open a hundred sockets at once. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}

async function main() {
  const listing = await store.list({ prefix: RUN_INDEX_PREFIX });
  const keys = listing.blobs.map((blob) => blob.key).filter((key) => key !== RUN_INDEX_META_KEY);
  const totals = { projects: 0, rows: 0, stale: 0, repaired: 0, ghosts: 0, unwritable: 0 };

  for (const key of keys) {
    const projectId = decodeURIComponent(key.slice(RUN_INDEX_PREFIX.length).replace(/\.json$/, ''));
    if (ONLY_PROJECT && projectId !== ONLY_PROJECT) continue;
    totals.projects++;

    const current = await getBlobJsonWithEtag(store, key);
    const rows = current.data?.runs ?? [];
    const stale = rows.filter((row) => (row.v ?? 0) < RUN_INDEX_VERSION);
    totals.rows += rows.length;
    totals.stale += stale.length;
    if (!stale.length) { console.log(`${projectId}: ${rows.length} rows, all at v${RUN_INDEX_VERSION}`); continue; }

    const records = await mapLimit(stale, 8, (row) => getBlobJson(store, `runs/${row.runId}.json`));
    const repaired = new Map();
    const ghosts = [];
    records.forEach((record, i) => {
      if (record) repaired.set(record.runId, { ...runSummaryOf(record), v: RUN_INDEX_VERSION });
      else ghosts.push(stale[i].runId);
    });
    totals.repaired += repaired.size;
    totals.ghosts += ghosts.length;

    const ghostIds = new Set(ghosts);
    const next = rows.filter((row) => !ghostIds.has(row.runId)).map((row) => repaired.get(row.runId) ?? row);
    console.log(`${projectId}: ${rows.length} rows, ${stale.length} stale, ${repaired.size} repaired, ${ghosts.length} ghost${ghosts.length === 1 ? '' : 's'}${APPLY ? '' : ' (dry run)'}`);
    if (ghosts.length) console.log(`  ghosts: ${ghosts.slice(0, 10).join(', ')}${ghosts.length > 10 ? ` … +${ghosts.length - 10}` : ''}`);
    if (!APPLY) continue;

    const write = await store.setJSON(key, { runs: next }, current.etag ? { onlyIfMatch: current.etag } : undefined);
    if (write && write.modified === false) {
      totals.unwritable++;
      console.warn(`  ${projectId}: index moved under us — rerun to finish this project.`);
    }
  }

  if (APPLY && totals.repaired > 0) {
    await store.setJSON(RUN_INDEX_META_KEY, { backfilledAt: new Date().toISOString(), v: RUN_INDEX_VERSION });
  }

  console.log('');
  console.log(`${APPLY ? 'applied' : 'DRY RUN'} — ${totals.projects} project(s), ${totals.rows} rows, ${totals.stale} stale, ${totals.repaired} repaired, ${totals.ghosts} ghost(s), ${totals.unwritable} project(s) left unwritten`);
  if (!APPLY && totals.stale > 0) console.log('rerun with --apply to write.');
}

main().catch((error) => { console.error(error?.message ?? error); process.exit(1); });
