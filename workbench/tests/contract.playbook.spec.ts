import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// CMS-Agent track A (2026-09-18) — contract tests for the playbook verbs, same pattern
// contract.stageSaveOutput.spec.ts established: hold the client's actual argument/result
// shapes against a captured (or, here, source-verified — see contracts/README.md's
// addendum) server shape, not against a fixture written to match the client. The bug
// this track fixed was exactly the kind these tests are meant to catch: verbs.ts sent
// `{op:'remove', lessonId}` to playbook_apply_delta and `{nodeId}` to
// playbook_migrate_observations, neither of which the live `.strict()` schemas accept.

function readContract(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../contracts/${name}`, import.meta.url)), 'utf8'));
}

function readVerbsSource(): string {
  return readFileSync(fileURLToPath(new URL('../src/api/verbs.ts', import.meta.url)), 'utf8');
}

function signatureOf(source: string, exportName: string): string {
  const start = source.indexOf(`export const ${exportName}`);
  if (start === -1) throw new Error(`verbs.ts has no export named ${exportName}`);
  const rest = source.slice(start);
  // Signatures here run from the export to the arrow `=>` that opens the body — a
  // generous slice (up to the first blank line after it) is enough to contain the
  // whole argument-shape literal without needing a real parser.
  const end = rest.indexOf('\n\n');
  return rest.slice(0, end === -1 ? rest.length : end);
}

// Extracts a brace-delimited block (an interface, a type literal, ...) starting at the
// first `{` at or after `startIndex`, matching braces by DEPTH rather than taking the
// first `}` — a naive `indexOf('}', startIndex)` stops at the first nested closing
// brace (e.g. the `{ text: string; kind: ... }` inside an `Array<{...}>` field) and
// silently truncates the block before the fields that follow it.
function braceBlockFrom(source: string, startIndex: number): string {
  const openIndex = source.indexOf('{', startIndex);
  if (openIndex === -1) throw new Error(`no '{' found at or after index ${startIndex}`);
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }
  throw new Error('unbalanced braces: no matching close found');
}

test('playbook_get: client reads the source-verified envelope shape (playbook, scope, rendered, composed)', () => {
  const contract = readContract('playbook_get.json') as {
    verb: string;
    sourceVerifiedAddendum: { call: { args: Record<string, unknown>; shape: { data: Record<string, unknown> } } };
  };
  expect(contract.verb).toBe('playbook_get');
  const dataShape = contract.sourceVerifiedAddendum.call.shape.data;
  expect(Object.keys(dataShape).sort()).toEqual(['composed', 'playbook', 'rendered', 'scope']);

  // adapters.ts's toPlaybookView must read every one of those fields off the raw envelope,
  // not invent its own — this is what makes the fixture-mode / live-mode split safe.
  const adapters = readFileSync(fileURLToPath(new URL('../src/api/adapters.ts', import.meta.url)), 'utf8');
  const fn = adapters.slice(adapters.indexOf('export function toPlaybookView'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  for (const field of ['raw.playbook', 'raw.scope', 'raw.rendered', 'raw.composed']) {
    expect(body).toContain(field);
  }

  // The call the addendum documents matches verbs.ts's own argument names.
  const signature = signatureOf(readVerbsSource(), 'playbookGet');
  for (const key of Object.keys(contract.sourceVerifiedAddendum.call.args)) {
    expect(signature).toContain(key);
  }
});

test('playbook_apply_delta: client sends the real {add,markHelpful,markHarmful,retire} delta shape, never {op,lessonId}', () => {
  const contract = readContract('playbook_apply_delta.json') as {
    verb: string;
    sourceVerifiedOnly: boolean;
    calls: Array<{ args: { delta: Record<string, unknown> } }>;
  };
  expect(contract.verb).toBe('playbook_apply_delta');
  expect(contract.sourceVerifiedOnly).toBe(true);

  // The delta's real keys live on the PlaybookDeltaInput interface (declared just
  // above playbookApplyDelta), not inline in the function body — read that block,
  // not the function signature, so this doesn't silently pass against unrelated text.
  const verbsSource = readVerbsSource();
  const interfaceStart = verbsSource.indexOf('export interface PlaybookDeltaInput');
  const deltaInterface = braceBlockFrom(verbsSource, interfaceStart);
  for (const key of ['add', 'markHelpful', 'markHarmful', 'retire']) {
    expect(deltaInterface).toContain(key);
  }
  // The shape this bug actually sent must be gone for good, in both the type and the call site.
  const signature = signatureOf(verbsSource, 'playbookApplyDelta');
  expect(deltaInterface).not.toContain('lessonId');
  expect(signature).not.toContain('lessonId');
  expect(signature).not.toContain('op:');

  // Every captured call's delta only uses real keys.
  const realKeys = new Set(['add', 'markHelpful', 'markHarmful', 'retire']);
  for (const call of contract.calls) {
    for (const key of Object.keys(call.args.delta)) {
      expect(realKeys.has(key)).toBe(true);
    }
  }
});

test('playbook_migrate_observations: client sends no nodeId — the real schema is global, {dryRun?} only', () => {
  const contract = readContract('playbook_migrate_observations.json') as {
    verb: string;
    sourceVerifiedOnly: boolean;
    calls: Array<{ args: Record<string, unknown> }>;
  };
  expect(contract.verb).toBe('playbook_migrate_observations');
  expect(contract.sourceVerifiedOnly).toBe(true);

  for (const call of contract.calls) {
    expect(Object.keys(call.args).every((k) => k === 'dryRun')).toBe(true);
  }

  const signature = signatureOf(readVerbsSource(), 'playbookMigrateObservations');
  expect(signature).not.toContain('nodeId');

  // Observations.tsx's migrate button must not be sending a per-node filter either —
  // this is the actual call site the bug shipped from. It wires the verb as a
  // mutationFn and fires it with `mutateAsync(undefined)` (a single global sweep),
  // not `{nodeId: ...}`.
  const observationsScreen = readFileSync(
    fileURLToPath(new URL('../src/screens/Learning/Observations.tsx', import.meta.url)),
    'utf8',
  );
  expect(observationsScreen).toContain('mutationFn: verbs.playbookMigrateObservations');
  const mutateCall = observationsScreen.slice(observationsScreen.indexOf('migrateM.mutateAsync('));
  const args = mutateCall.slice(0, mutateCall.indexOf(')') + 1);
  expect(args).not.toContain('nodeId');
  expect(args).toContain('undefined');
});
