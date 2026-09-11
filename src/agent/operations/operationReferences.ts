// Typed references for the operation catalog (A2). Every reference type carries an explicit,
// structurally distinct shape — never a bare string id — so a caller cannot coerce one kind into
// another by renaming a parameter (an ObjectRef cannot be mistaken for an AssetRef; AssetRef alone
// carries an explicit `kind` discriminant across its own three asset kinds). Schemas are `.strict()`
// so an unrecognized or malformed shape is rejected rather than silently coerced.
//
// validateReference() never throws a bare string on a bad reference: every failure comes back as a
// structured OperationBlocker (see operationTypes.ts), including the cross-tenant refusal — a
// reference whose tenantId does not match the operation's own tenantId is refused here, before any
// caller of this module gets a chance to act on it.

import { z } from "zod";
import type { OperationBlocker } from "./operationTypes.js";

export const objectRefSchema = z.object({
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  tenantId: z.string().min(1),
  revision: z.string().min(1).optional()
}).strict();
export type ObjectRef = z.infer<typeof objectRefSchema>;

export const assetRefKinds = ["capture_artifact", "stored_media", "content_linked_asset"] as const;
export const assetRefSchema = z.object({
  kind: z.enum(assetRefKinds),
  assetId: z.string().min(1),
  tenantId: z.string().min(1),
  checksum: z.string().min(1).optional(),
  // Same strict-zod treatment as TemplateRef's own `surface` (the enum is closed to exactly "web" |
  // "pdf") but OPTIONAL/nullable here, because unlike a TemplateRef an asset is not always bound to
  // one surface. This is a CALLER-DECLARED HINT, not a fact this module verifies: where the stored
  // artifact's own media type is known (an adopting executor reading the asset record itself), that
  // known type wins over whatever a caller declared here. A caller — or a model turn proposing a
  // plan — must never be able to steer routing to the PDF-only or web-only branch of an operation by
  // simply declaring a surface the underlying artifact does not actually have; this field only ever
  // narrows disambiguation among ALREADY-VALID candidate operations (operationDisambiguation.ts), it
  // never substitutes for the artifact's real type at execution time.
  surface: z.enum(["web", "pdf"]).nullable().optional()
}).strict();
export type AssetRef = z.infer<typeof assetRefSchema>;

export const templateRefSchema = z.object({
  surface: z.enum(["web", "pdf"]),
  templateId: z.string().min(1),
  tenantId: z.string().min(1),
  version: z.string().min(1).optional()
}).strict();
export type TemplateRef = z.infer<typeof templateRefSchema>;

export type OperationReference = ObjectRef | AssetRef | TemplateRef;

// Which candidate schema a raw reference-shaped value is attempting to satisfy, chosen by which
// id field it carries (assetId / templateId / objectId). Used only to pick the ONE schema to
// validate against and to report a precise blocker — never to guess a type past what the value's
// own shape states, and never to let one type's fields leak into another's validation.
const impliedRefKind = (value: Record<string, unknown>): "asset" | "template" | "object" | null => {
  if ("assetId" in value) return "asset";
  if ("templateId" in value) return "template";
  if ("objectId" in value) return "object";
  return null;
};

const refShapeBlocker = (value: unknown, issues: string[]): OperationBlocker => ({
  code: "reference_shape_invalid",
  message: `Reference does not match any registered reference shape (ObjectRef, AssetRef, TemplateRef): ${issues.join("; ") || "no recognizable id field (objectId/assetId/templateId) present"}.`,
  remedy: "Supply a reference shaped as one of ObjectRef {objectType, objectId, tenantId}, AssetRef {kind, assetId, tenantId}, or TemplateRef {surface, templateId, tenantId}.",
  blocking: true,
  evidence: { reference: value }
});

export type ReferenceValidation =
  | { ok: true; reference: OperationReference }
  | { ok: false; blocker: OperationBlocker };

// Validates a single candidate reference against exactly the schema its own shape implies, then
// refuses (never throws) a tenant mismatch. This is the ONLY place a reference's tenantId is
// checked against the operation's tenantId — every caller (preflight's reference scan, a future
// executor) is expected to route through here rather than re-deriving the check.
export function validateReference(ref: unknown, opts: { tenantId: string }): ReferenceValidation {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    return { ok: false, blocker: refShapeBlocker(ref, ["reference must be an object"]) };
  }
  const record = ref as Record<string, unknown>;
  const impliedKind = impliedRefKind(record);
  const parsed =
    impliedKind === "asset" ? assetRefSchema.safeParse(ref) :
    impliedKind === "template" ? templateRefSchema.safeParse(ref) :
    impliedKind === "object" ? objectRefSchema.safeParse(ref) :
    null;
  if (!parsed) return { ok: false, blocker: refShapeBlocker(ref, []) };
  if (!parsed.success) return { ok: false, blocker: refShapeBlocker(ref, parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)) };
  const reference = parsed.data as OperationReference;
  if (reference.tenantId !== opts.tenantId) {
    return {
      ok: false,
      blocker: {
        code: "reference_tenant_mismatch",
        message: `Reference tenantId "${reference.tenantId}" does not match the operation's tenantId "${opts.tenantId}".`,
        remedy: `Supply a reference whose tenantId is "${opts.tenantId}", or run this operation against tenant "${reference.tenantId}" instead.`,
        blocking: true,
        evidence: { referenceTenantId: reference.tenantId, operationTenantId: opts.tenantId, reference: record }
      }
    };
  }
  return { ok: true, reference };
}
