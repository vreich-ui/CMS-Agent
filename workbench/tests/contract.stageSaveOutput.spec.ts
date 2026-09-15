import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// W0 contract test (node-default-output, 2026-09-15) — held against the VERBATIM live
// capture in contracts/stage_save_output.json, not against a fixture written to match
// the client.
//
// What this locks down, and why it is worth a test rather than a note in a PR: the
// override modal shipped sending a payload the server's published schema rejected
// outright, and nothing caught it because the workbench's own mock handler happily
// accepted it. A contract test reads the SERVER's shape — the one the live capture
// recorded — and asserts the client still sends that shape. The pre-W3 rejection is
// kept in the same file as the reason this test exists.

interface CapturedCall {
  args: Record<string, unknown>;
  ok: boolean;
  form: 'workspace' | 'run_scoped';
  error?: string;
  serverSchemaAtCapture?: { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
}

interface Captured {
  verb: string;
  calls: CapturedCall[];
  expectedAfterW3: {
    forms: string[];
    run_scoped: { args: Record<string, unknown> };
  };
}

const captured = JSON.parse(
  readFileSync(fileURLToPath(new URL('../contracts/stage_save_output.json', import.meta.url)), 'utf8'),
) as Captured;

const callOfForm = (form: CapturedCall['form']): CapturedCall => {
  const call = captured.calls.find((candidate) => candidate.form === form);
  if (!call) throw new Error(`contracts/stage_save_output.json has no ${form} call`);
  return call;
};

test('stage_save_output: the live capture records the pre-W3 refusal of the modal payload', () => {
  expect(captured.verb).toBe('stage_save_output');
  const runScoped = callOfForm('run_scoped');
  // The refusal is the FINDING, not an incidental failure — if this ever starts
  // reading ok:true the capture has been re-run against a fixed server and the
  // file's `expectedAfterW3` block is what should be asserted instead.
  expect(runScoped.ok).toBe(false);
  expect(runScoped.error).toContain('did not match the tool schema');
  expect(runScoped.serverSchemaAtCapture?.additionalProperties).toBe(false);
  expect(runScoped.serverSchemaAtCapture?.required).toEqual(['stage', 'value']);
  // Every key the modal sends, and not one of them recognised.
  for (const key of ['runId', 'nodeId', 'note']) {
    expect(Object.keys(runScoped.serverSchemaAtCapture?.properties ?? {})).not.toContain(key);
  }
  // The workspace form DID work — which is exactly why this was invisible: the verb
  // was healthy, it was just writing somewhere no run reads.
  expect(callOfForm('workspace').ok).toBe(true);
});

test('stage_save_output: the client still sends the run-scoped form W3 accepts', () => {
  // Read the verb's own declared argument shape from source rather than re-deriving it
  // here: this test exists because client and server drifted, so it must fail when the
  // CLIENT changes, not only when the capture does.
  const source = readFileSync(fileURLToPath(new URL('../src/api/verbs.ts', import.meta.url)), 'utf8');
  const signature = source.slice(source.indexOf('export const stageSaveOutput'));
  const args = signature.slice(0, signature.indexOf(')'));
  for (const key of Object.keys(captured.expectedAfterW3.run_scoped.args)) {
    if (key === 'note') continue; // optional in both directions
    expect(args).toContain(key);
  }
  expect(captured.expectedAfterW3.forms).toEqual(['workspace', 'run_scoped']);
});
