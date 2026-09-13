// Binding input-contract resolution (R1c). A pure, static check over SCHEMAS: given one
// OperationWorkflowBinding, can the operation's own input schema — after its `defaults` are applied
// and the binding's `inputMapping` renames fields — actually satisfy what the target workflow's ENTRY
// NODE(S) declare as required input? This is the check operationWorkflowBindings.ts's own
// assertBindingIsSound never performed (see that module's header and its own comment on
// assertBindingIsSound): assertBindingIsSound only checks that `workflowId` names something
// workflowRegistry.ts registered, never that the operation's INPUT reaches that workflow able to
// satisfy what its entry node requires. A binding can pass assertBindingIsSound and still be
// hopelessly incomplete — that gap is exactly what this module makes visible.
//
// STATIC, NOT RUNTIME. This never looks at any particular caller's input — that is
// operationPreflight.ts's job (`mergedInput`, `missingRequired`) for the ACTUAL request in hand. This
// module answers a narrower, schema-only question: could ANY valid caller of this operation ever
// reach the target workflow with enough input to pass the entry node's own inputSchema, given only
// what the operation's schema GUARANTEES — its own `required` fields (always supplied, or the
// operation's own inputSchema validation already refuses the call) and its own `defaults` (always
// filled in when the caller omits them, exactly like operationPreflight.ts's appliedDefaults loop) —
// run through the binding's field-rename table? A field the operation's schema makes OPTIONAL and has
// no default is NOT guaranteed, and is treated exactly like a field a caller left out: this is
// deliberately the pessimal case, because a real caller CAN leave it out. A field with no entry in
// inputMapping never reaches the target node under any name and is dropped, matching
// operationWorkflowBindings.ts's own "left OUT rather than guessed at" discipline for inputMapping.
//
// WHICH NODE(S) IN THE TARGET WORKFLOW ARE "THE ENTRY NODE"? Not a convention this module invents —
// it is how executor.ts itself already treats a node's dependsOn: a node whose dependsOn is EMPTY is
// the one whose `state.input` is built from the run's own `initialInput` directly; every other node's
// input comes from `dependencies: Object.fromEntries(node.dependsOn.map(dep => [dep,
// run.stageOutputs[dep]]))` instead (executor.ts's runnable-node input assembly). So an operation's
// caller-supplied input, after mapping, only ever reaches a node with an empty dependsOn — a
// downstream node's real input is its upstream node's OUTPUT, not the operation's input, no matter
// what its own inputSchema declares. "Entry node" is therefore derived STRUCTURALLY from the
// workflow's own canonical node array (dependsOn.length === 0) on every call — never a hardcoded node
// id — so this keeps working unmodified if a workflow's entry node is renamed or a workflow gains a
// second one (clone_conductor already has two: clone_intake and pdf_template_intake).
//
// WHICH JSON-SCHEMA CONSTRUCTS THIS EVALUATES, AND WHY THOSE TWO. A top-level `required: string[]`,
// and a top-level `anyOf` whose every branch is EXACTLY `{ required: string[] }` (no other key on the
// branch) — those are the two forms every entry node's inputSchema in this codebase actually uses
// today (visualIdentityNodes.ts's brand_imagery_writer is the only entry node with either at all; see
// this module's own test file for the inventory). ANY OTHER TOP-LEVEL KEYWORD THAT COULD AFFECT
// WHAT'S REQUIRED — oneOf, allOf, not, if/then/else, dependentRequired, dependentSchemas, $ref, or an
// anyOf branch shaped as anything other than `{required:[...]}` — IS NOT EVALUATED, and is recorded as
// an unsupported construct that makes the node's own check UNSATISFIABLE. Never report satisfiable on
// a construct this function did not actually check: an unevaluated "maybe" must read as "no".
import type { WorkspaceNode } from "../workspace/nodeTypes.js";

// What the CALLER (operationWorkflowBindings.ts, operationPreflight.ts) extracts from one operation's
// OWN descriptor before calling checkBindingInputContract — deliberately just these two plain string
// arrays, not the whole OperationDescriptor, so this module never needs to import operationTypes.ts
// or operationCatalog.ts and stays independently testable against synthetic fixtures (see the task's
// own "keep it pure" instruction).
export type OperationInputContractSource = {
  // The operation's own inputSchema.required array (top-level only — every operation descriptor in
  // this codebase expresses its own required fields this way; none uses a top-level anyOf).
  requiredFields: readonly string[];
  // The operation's own `defaults` object's keys — fields preflightOperation ALWAYS fills in when the
  // caller omits them. Guaranteed present the same way requiredFields is.
  defaultedFields: readonly string[];
};

export type EntryNodeRequirementCheck = {
  nodeId: string;
  // The node's own top-level `required` fields that the guaranteed (mapped) field set does NOT cover.
  // Empty when the node declares no top-level `required` at all.
  unsatisfiedRequired: string[];
  // null when the node's inputSchema has no top-level `anyOf` (nothing to satisfy on that axis).
  // Otherwise one entry per recognized branch, each branch's own `required` array, in schema order.
  anyOfBranches: string[][] | null;
  // The index into anyOfBranches of the first branch the guaranteed set fully covers, or null when
  // anyOfBranches is null, or non-null but no branch is covered.
  satisfiedAnyOfBranchIndex: number | null;
  // Top-level schema keywords (or `anyOf[<index>]` for an unrecognized branch shape) this checker does
  // not evaluate. Non-empty unconditionally makes `satisfied` false — see this module's header.
  unsupportedConstructs: string[];
  // true iff unsupportedConstructs is empty, unsatisfiedRequired is empty, and (anyOfBranches is null
  // OR satisfiedAnyOfBranchIndex is not null).
  satisfied: boolean;
};

export type BindingInputContractResult = {
  workflowId: string;
  // The TARGET field names the mapped operation input is guaranteed to carry into the entry node(s),
  // sorted for deterministic snapshotting.
  guaranteedTargetFields: string[];
  // One entry per resolved entry node. Empty only when the workflow's canonical node array genuinely
  // has no node with an empty dependsOn — a workflow-authoring defect this checker also refuses to
  // paper over: no entry node means nothing was actually checked, so `satisfied` is false, never
  // vacuously true.
  entryNodeChecks: EntryNodeRequirementCheck[];
  // true iff entryNodeChecks is non-empty and every entry in it is satisfied.
  satisfied: boolean;
};

// Keywords that, if present at the schema's top level, could add or relax a requirement this checker
// does not evaluate. Listed explicitly (rather than "anything not required/anyOf/type/properties/
// additionalProperties") so a harmless, non-requirement keyword landing on a future node schema (a
// `description`, a `$comment`, a `title`) never spuriously flips a satisfied contract to unsatisfiable.
const UNEVALUATED_REQUIREDNESS_KEYWORDS = [
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "$ref"
] as const;

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

// Every operation-side field the operation's own schema guarantees present (required, or defaulted),
// renamed through inputMapping. A field with no mapping is dropped: it never reaches the target
// workflow's node under any name, so it cannot satisfy anything there.
function resolveGuaranteedTargetFields(source: OperationInputContractSource, inputMapping: Readonly<Record<string, string>>): string[] {
  const guaranteedSourceFields = new Set<string>([...source.requiredFields, ...source.defaultedFields]);
  const target = new Set<string>();
  for (const sourceField of guaranteedSourceFields) {
    const mapped = inputMapping[sourceField];
    if (typeof mapped === "string" && mapped.length > 0) target.add(mapped);
  }
  return [...target].sort();
}

// The workflow's entry node(s): nodes whose dependsOn is empty — exactly the nodes executor.ts's own
// state.input assembly hands the run's initialInput to directly (see this module's header). Derived
// from the CANONICAL NODE ARRAY the caller hands in — never a hardcoded node id, and never limited to
// exactly one node.
export function resolveWorkflowEntryNodes(canonicalNodes: readonly WorkspaceNode[]): WorkspaceNode[] {
  return canonicalNodes.filter((node) => node.dependsOn.length === 0);
}

function checkEntryNode(node: WorkspaceNode, guaranteedTargetFields: ReadonlySet<string>): EntryNodeRequirementCheck {
  const schema = (node.inputSchema && typeof node.inputSchema === "object" ? node.inputSchema : {}) as Record<string, unknown>;
  const unsupportedConstructs: string[] = [];
  for (const keyword of UNEVALUATED_REQUIREDNESS_KEYWORDS) {
    if (keyword in schema) unsupportedConstructs.push(keyword);
  }

  const requiredFields = isStringArray(schema.required) ? schema.required : [];
  const unsatisfiedRequired = requiredFields.filter((field) => !guaranteedTargetFields.has(field));

  let anyOfBranches: string[][] | null = null;
  let satisfiedAnyOfBranchIndex: number | null = null;
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      // Present but not a usable array of branches — unevaluated, not silently ignored.
      unsupportedConstructs.push("anyOf");
    } else {
      const branches: string[][] = [];
      let allBranchesRecognized = true;
      (schema.anyOf as unknown[]).forEach((branch, index) => {
        const branchIsExactlyRequired =
          !!branch &&
          typeof branch === "object" &&
          !Array.isArray(branch) &&
          Object.keys(branch as Record<string, unknown>).length === 1 &&
          isStringArray((branch as Record<string, unknown>).required);
        if (!branchIsExactlyRequired) {
          unsupportedConstructs.push(`anyOf[${index}]`);
          allBranchesRecognized = false;
          return;
        }
        branches.push((branch as { required: string[] }).required);
      });
      if (allBranchesRecognized) {
        anyOfBranches = branches;
        const foundIndex = branches.findIndex((branch) => branch.every((field) => guaranteedTargetFields.has(field)));
        satisfiedAnyOfBranchIndex = foundIndex === -1 ? null : foundIndex;
      }
      // else: at least one branch was unrecognized — anyOfBranches stays null and the unrecognized
      // branch(es) already recorded themselves in unsupportedConstructs above, which alone is enough
      // to fail `satisfied` for this node.
    }
  }

  const satisfied =
    unsupportedConstructs.length === 0 &&
    unsatisfiedRequired.length === 0 &&
    (anyOfBranches === null || satisfiedAnyOfBranchIndex !== null);

  return { nodeId: node.id, unsatisfiedRequired, anyOfBranches, satisfiedAnyOfBranchIndex, unsupportedConstructs, satisfied };
}

// The main entry point. `workflowId` is carried through only for the result shape's own
// self-description (so a caller doesn't have to thread it back through separately) — this function
// never looks it up anywhere and never uses it to decide anything.
export function checkBindingInputContract(
  workflowId: string,
  inputMapping: Readonly<Record<string, string>>,
  source: OperationInputContractSource,
  canonicalNodes: readonly WorkspaceNode[]
): BindingInputContractResult {
  const guaranteedTargetFields = resolveGuaranteedTargetFields(source, inputMapping);
  const guaranteedSet = new Set(guaranteedTargetFields);
  const entryNodes = resolveWorkflowEntryNodes(canonicalNodes);
  const entryNodeChecks = entryNodes.map((node) => checkEntryNode(node, guaranteedSet));
  const satisfied = entryNodeChecks.length > 0 && entryNodeChecks.every((check) => check.satisfied);
  return { workflowId, guaranteedTargetFields, entryNodeChecks, satisfied };
}
