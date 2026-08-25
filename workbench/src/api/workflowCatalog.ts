// Workflow catalog — UI presentation config, NOT live API data.
//
// HANDOFF §6 has no "list workflows" MCP verb. The 3 conductor workflows
// (icon/short/desc marketing copy, and the phase groupings/labels used to
// lay out the rail and the graph overlay) exist only as an editorial
// decision baked into this app, originally lifted from spec/mockup.html.
// This file is that decision, made explicit as a local constant — it is
// never fetched, and nothing here should be mistaken for a live response.
//
// What IS live and was cross-checked against the running workspace
// (2026-08-25, see fixtures/README.md): every node id listed in every
// phase array below. `publishing_conductor`'s 23 ids match
// `workspace_get_nodes` exactly. `clone_conductor`'s 9 ids (including
// `fit_adjudicator`, absent from the mockup's original 8-node design) and
// `capture_conductor`'s 11 ids match node ids observed in real
// `workflow_list_runs` run histories — `workspace_get_graph` /
// `workspace_get_nodes` / `workspace_get_node` only ever return
// publishing_conductor's nodes live, so clone/capture topology has no
// other live source to check against; see GraphOverlay.tsx's own honest
// gap notice for the same limit.
//
// Editing this file changes what phase columns/labels the rail and graph
// overlay show — it does not, and cannot, change what nodes actually exist
// in the workspace.

import type { Workflow } from '../types';

export const WORKFLOW_CATALOG: Record<string, Workflow> = {
  publishing_conductor: {
    id: 'publishing_conductor',
    name: 'Publishing conductor',
    fn: 'DTC publishing specialist',
    icon: 'ic-pub',
    short: 'Strategy → research → draft → review → gated publish',
    desc: '23-node article production line: strategy → research → draft → four-way review → build → gated publish → learning.',
    phases: [
      ['Intake', ['input_triage']],
      ['Strategy', ['placement_resolver', 'topic_opportunity', 'monetization_strategy', 'reader_insight']],
      ['Research', ['research', 'objection_mapping', 'narrative_movement', 'angle_strategy']],
      ['Planning', ['brief_architect', 'contract_intelligence']],
      ['Drafting', ['draft_writer']],
      ['Review', ['human_texture', 'trust_factual', 'emotional_resonance', 'reader_simulation', 'review_aggregator']],
      ['Build', ['article_body', 'artifact_plan', 'publish_payload']],
      ['Publish', ['publication_controller', 'publish_executor']],
      ['Learning', ['learning_recorder']],
    ],
  },
  clone_conductor: {
    id: 'clone_conductor',
    name: 'Clone conductor',
    fn: 'Site cloning & template generation specialist',
    icon: 'ic-clone',
    short: 'Capture → recipes → theme bind → fit check → restamp',
    desc: "9-node pipeline (live): intake a capture, analyse layout, design & mint recipes, reconcile and bind theme, adjudicate fit, restamp pages, report. Differs from the original 8-node design by one node, fit_adjudicator, observed in live runs between theme_bind and layout_restamp.",
    phases: [
      ['Intake & analysis', ['clone_intake', 'layout_analyst']],
      ['Recipes', ['recipe_designer', 'recipe_mint']],
      ['Theme & fit', ['theme_reconciler', 'theme_bind', 'fit_adjudicator']],
      ['Restamp & report', ['layout_restamp', 'clone_report']],
    ],
  },
  capture_conductor: {
    id: 'capture_conductor',
    name: 'Capture conductor',
    fn: 'Site capture & fidelity specialist',
    icon: 'ic-capture',
    short: 'Crawl → map → theme → emit → score',
    desc: '11-node pipeline: crawl → map → classify → refine → theme → dry emit → regenerate copy → live emit → score → adjudicate → report.',
    phases: [
      ['Crawl & map', ['capture_crawl', 'capture_map', 'block_classifier', 'capture_map_refine']],
      ['Theme & emit', ['capture_theme', 'capture_emit_dry', 'copy_regenerator', 'capture_emit_live']],
      ['Score & report', ['capture_score', 'gap_adjudicator', 'capture_report']],
    ],
  },
};
