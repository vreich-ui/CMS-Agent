// Scoped authorization (A4). An approval is a SCOPED COLLECTION OF EFFECTS, never a blanket
// `approved: true` flag: ScopedApproval below names exactly which changeSetId + revisionId it was
// granted for, which effects, and which targets — nothing wider.
//
// THIS MODULE NEVER EXECUTES ANYTHING. authorizeEffects() returns a per-effect decision
// (allowed/denied + reason); it is the EXECUTING CALLER's job to honour a "denied" decision by not
// running that effect. Nothing in this module is itself an authority any more than
// operationPreflight.ts's blockers are — see that module's header for the identical posture. This is
// NOT a second gate alongside `resolvePublishAuthority`/`publisher.ts` (AGENTS.md invariant 4/5) and
// never will be: it governs the candidate/change-set kernel this file lives beside, and an executor
// that later runs a change set's effects still goes through whatever real authority governs the
// target (a node's own riskLevel dispatch, the publish gates, tenant tool policy) exactly as before.
//
// NO CALLER- OR MODEL-SUPPLIED PRINCIPAL, SCOPE, ACTOR, OR `approved` FIELD IS EVER READ. The only
// fields authorizeEffects consults are the five named on ScopedApproval below, compared against the
// ChangeSet it is asked to authorize. An approval-shaped payload carrying extra properties —
// `approved: true`, a `principal`, a widened `scope` — produces the IDENTICAL verdict as the same
// payload without them, because those properties are never read, not merely unused. See
// operationPreflight.ts's identical discipline for `request` fields it does not consult.
import type { ChangeSet, ChangeSetTarget } from "./changeSet.js";
import { targetKey } from "./changeSet.js";
import type { OperationEffect } from "./operationTypes.js";
import type { WorkspaceRiskLevel } from "../workspace/nodeTypes.js";

export type ScopedApproval = {
  changeSetId: string;
  revisionId: string | null;
  grantedEffects: OperationEffect[];
  // Target keys as changeSet.ts's targetKey() encodes them — never a bare objectId, so an approval
  // scoped to one object type can never be mistaken for covering a different type's object of the
  // same id.
  grantedTargets: string[];
  grantedAtISO: string;
  grantedBy: string;
};

export type EffectAuthorizationDecision = {
  effect: OperationEffect;
  decision: "allowed" | "denied";
  reason: string;
};

export type AuthorizeEffectsResult = {
  changeSetId: string;
  decisions: EffectAuthorizationDecision[];
  // Convenience only — every individual decision is what an executing caller must actually honour.
  allAllowed: boolean;
};

// Reuses the SAME riskLevel vocabulary a WorkspaceNode carries (operationTypes.ts's OperationEffect
// already does this) — "read" is the one riskLevel that passes without an approval at all, matching
// AGENTS.md's own reservation of "read" as the non-authorizing tier. This is not a parallel
// classification: it is reading the exact field OperationEffect already carries.
const isReadClassEffect = (riskLevel: WorkspaceRiskLevel): boolean => riskLevel === "read";

const effectGrantedBy = (grantedEffects: OperationEffect[], effect: OperationEffect): boolean =>
  grantedEffects.some((granted) => granted.kind === effect.kind && granted.targetType === effect.targetType);

const allTargetsGranted = (affectedTargets: ChangeSetTarget[], grantedTargets: string[]): boolean =>
  affectedTargets.every((target) => grantedTargets.includes(targetKey(target)));

// Per-effect decision. A read-class effect is ALWAYS allowed, with no approval consulted at all —
// "routine validation requires no approval" (coordinator contract). Every other effect requires an
// approval that names this EXACT changeSetId and this EXACT revisionId (a stale or differently-
// scoped approval denies every non-read effect, not just the ones it happens not to mention) and
// that grants both the specific effect (by kind + targetType) and every target the change set
// affects.
export function authorizeEffects(changeSet: ChangeSet, approval: ScopedApproval | null | undefined): AuthorizeEffectsResult {
  const decisions: EffectAuthorizationDecision[] = changeSet.effects.map((effect) => {
    if (isReadClassEffect(effect.riskLevel)) {
      return { effect, decision: "allowed", reason: 'Read-class effect (riskLevel "read") requires no approval.' };
    }

    if (!approval) {
      return { effect, decision: "denied", reason: "No approval was supplied for a non-read effect." };
    }
    if (approval.changeSetId !== changeSet.changeSetId) {
      return {
        effect,
        decision: "denied",
        reason: `Approval is scoped to changeSetId "${approval.changeSetId}", not this change set's "${changeSet.changeSetId}".`
      };
    }
    if (approval.revisionId !== changeSet.revisionId) {
      return {
        effect,
        decision: "denied",
        reason: `Approval is scoped to revisionId ${JSON.stringify(approval.revisionId)}, not this change set's ${JSON.stringify(changeSet.revisionId)}.`
      };
    }
    if (!allTargetsGranted(changeSet.affectedTargets, approval.grantedTargets)) {
      return { effect, decision: "denied", reason: "Approval does not grant every target this change set affects." };
    }
    if (!effectGrantedBy(approval.grantedEffects, effect)) {
      return { effect, decision: "denied", reason: `Approval does not grant the "${effect.kind}" effect on target type "${effect.targetType}".` };
    }
    return { effect, decision: "allowed", reason: "Approval explicitly grants this effect for this exact change set and revision." };
  });

  return { changeSetId: changeSet.changeSetId, decisions, allAllowed: decisions.every((decision) => decision.decision === "allowed") };
}
