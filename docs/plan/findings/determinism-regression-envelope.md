# Canonical input envelope for platform-site (own-property) runs

**Finding (determinism-regression run `run_1786549907145_hf4wgb`, 2026-08-12).** The regression-test
envelope was a byte-identical replay of `run_1786468126136_ev9goe`'s input — which predates the
content-class signal. With no `contentClass` declared, the run defaulted to `client_property`, so:

- the standing own-property EV/aggression waiver (`publicationController`,
  `own_property_ev_and_aggression_exemption`) waived nothing, and `aggression_ceiling_missing`
  hard-blocked the decision (also W6.2: the platform contract still declares no `aggression_ceiling`);
- the W4 skip predicates that key on declared class could not fire: `research` ran (no
  external-claims declaration either — skip rule 3 resolves toward running, by design),
  `monetization_strategy` ran, and the full review quartet ran. Only `artifact_plan` skipped, because
  zero-media is a structural fact, not a class signal.

None of that is engine misbehavior — the signals are explicit by design ("a waiver that switches
itself on from an inferred signal is a waiver nobody authorized"). The fix is in the ENVELOPE.

## The envelope

For articles published to the Kugel Platform's own site, declare the class (and, where true, the
absence of external claims) on the run input:

```json
{
  "artifact": "content_source.v1",
  "summary": "<what the piece is>",
  "trafficSource": "seo",
  "awarenessStage": "solution_aware",
  "contentClass": "own_property",
  "externalClaims": false,
  "notes": ["<run-specific notes>"]
}
```

- `contentClass: "own_property"` — read by `readDeclaredContentClass` (top level or under
  `contentSource`; `ownProperty: true` also accepted). Activates the audited EV/aggression waiver and
  the `content_class_in` skip for `monetization_strategy`; docs/runbook classes (`docs`, `runbook`,
  `reference`, …) additionally tier the review quartet and skip `research`.
- `externalClaims: false` — read by the `no_external_claims` predicate (also accepted:
  `requiresResearch`, `researchRequired`, …). Declare it only when the piece genuinely makes no
  externally-verifiable claim; omit it to keep research.
- Omit both and the run behaves exactly as before: full pipeline, nothing waived.

## Replay caveat

A determinism-regression replay of a PRE-signal run against POST-W4 code is comparing two different
policies unless the envelope is upgraded. Either upgrade the replay envelope with the fields above
(tests the new policy end-to-end) or expect the full-pipeline shape with a `blocked` decision on
`client_property` content (tests the old shape under the new gate).
