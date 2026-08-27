// Workflow catalog — UI presentation config, NOT live API data.
//
// This file holds ONE thing: the editorial phase names and their ordering,
// used to group the rail and the graph overlay. It is not, and must never
// again be, the source of truth for which nodes exist.
//
// It was exactly that, and it was wrong. It claimed 9 nodes for
// clone_conductor where the live conductor runs 18 (the four
// `pdf_template_*` nodes and the entire shared publish tail were missing)
// and 11 for capture_conductor where live runs 16. The rail read from this
// file, so two of the three workflows showed the operator a pipeline that
// did not match the one the workspace runs.
//
// The node set now comes from `workspace_get_graph({workflowId})` — see
// verbs.workspaceGetNodes and hooks.useWorkflowGraph. The phase lists below
// are aligned to the live topology captured 2026-08-26 (WP-00,
// workbench/contracts/), and the rail still shows any live node no phase
// claims, under an explicit "ungrouped (live)" heading — so a node the
// workspace runs can never silently disappear from this screen again, even
// if these lists go stale.
//
// The three conductors share a publish tail (publish_payload,
// publication_controller, publish_executor, release_executor,
// learning_recorder), which is why the per-workflow counts (24 + 16 + 18)
// sum to more than the workspace's 48 distinct nodes.

import type { Workflow } from '../types';

export const WORKFLOW_CATALOG: Record<string, Workflow> = {
  publishing_conductor: {
    id: 'publishing_conductor',
    name: 'Publishing conductor',
    fn: 'DTC publishing specialist',
    icon: 'ic-pub',
    short: 'Strategy → research → draft → review → gated publish → release',
    desc: '24-node article production line: strategy → research → draft → four-way review → build → gated publish → learning.',
    phases: [
      ['Intake', ['input_triage']],
      ['Strategy', ['placement_resolver', 'topic_opportunity', 'monetization_strategy', 'reader_insight']],
      ['Research', ['research', 'objection_mapping', 'narrative_movement', 'angle_strategy']],
      ['Planning', ['brief_architect', 'contract_intelligence']],
      ['Drafting', ['draft_writer']],
      ['Review', ['human_texture', 'trust_factual', 'emotional_resonance', 'reader_simulation', 'review_aggregator']],
      ['Build', ['artifact_plan', 'article_body', 'publish_payload']],
      ['Publish', ['publication_controller', 'publish_executor', 'release_executor']],
      ['Learning', ['learning_recorder']],
    ],
  },
  clone_conductor: {
    id: 'clone_conductor',
    name: 'Clone conductor',
    fn: 'Site cloning & template generation specialist',
    icon: 'ic-clone',
    short: 'Capture → recipes → theme bind → fit check → restamp → publish',
    desc: '18-node pipeline: intake a capture, analyse layout, design and mint recipes, reconcile and bind theme, adjudicate fit, restamp pages, report — plus the PDF template workspace and the shared gated publish tail.',
    phases: [
      ['Intake & analysis', ['clone_intake', 'layout_analyst']],
      ['Recipes', ['recipe_designer', 'recipe_mint']],
      ['Theme & fit', ['theme_reconciler', 'theme_bind', 'fit_adjudicator']],
      ['Restamp & report', ['layout_restamp', 'clone_report']],
      ['PDF templates', ['pdf_template_intake', 'pdf_template_designer', 'pdf_template_mint', 'pdf_template_publish']],
      ['Publish', ['publish_payload', 'publication_controller', 'publish_executor', 'release_executor']],
      ['Learning', ['learning_recorder']],
    ],
  },
  capture_conductor: {
    id: 'capture_conductor',
    name: 'Capture conductor',
    fn: 'Site capture & fidelity specialist',
    icon: 'ic-capture',
    short: 'Crawl → map → theme → emit → score',
    desc: '16-node pipeline: crawl → map → classify → refine → theme → dry emit → regenerate copy → live emit → score → adjudicate → report, then the shared gated publish tail.',
    phases: [
      ['Crawl & map', ['capture_crawl', 'capture_map', 'block_classifier', 'capture_map_refine']],
      ['Theme & emit', ['capture_theme', 'capture_emit_dry', 'copy_regenerator', 'capture_emit_live']],
      ['Score & report', ['capture_score', 'gap_adjudicator', 'capture_report']],
      ['Publish', ['publish_payload', 'publication_controller', 'publish_executor', 'release_executor']],
      ['Learning', ['learning_recorder']],
    ],
  },
};
