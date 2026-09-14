// Milestone A remainder — THE ONE PLACE a pdf-tool call's `siteId` comes from.
//
// Every pdf-tool verb a tenant server exposes (create_pdf_template, validate_pdf_template,
// publish_pdf_template, preview_pdf_template_fixture, document_render, ...) is scoped by `site_id`,
// and Platform refuses any value but its own deployment's site object id
// (mcp-tool-handlers.ts: "Artifact scope mismatch: this deployment owns ${identity.siteId}, not
// ${siteId}", error_code artifact_site_mismatch). That id is `site_<client>` — projectTypes.ts's
// ProjectObjectDialect.siteObjectId, minted by platformScaffoldObjectIds at genesis
// (siteGenesis.ts writes it on the record) — and it is NOT the tenantId: dr-lurie's site is
// site_drlurie, zilberman's is site_zilberman. mcpBoundary.ts forwards the engine's `siteId` to the
// wire as `site_id` verbatim, with no translation.
//
// Two call sites had been passing the tenantId (imageTemplateRevisionEngine.ts's apply stage set
// `siteId = intake.tenantId`; pdf_template_family's brief had no builder and would have needed the
// caller to know the convention). Both now resolve through here, from the project record, and refuse
// by name when the record has none — never a placeholder, never the tenantId as a stand-in.
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";

export type PdfToolSiteScope =
  | { ok: true; siteId: string }
  | { ok: false; code: "pdf_tool_site_id_unresolved" | "pdf_tool_site_id_mismatch"; reason: string };

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * PURE. `declared` is a siteId the caller (a hand-built brief, an operator surface) may have named
 * itself; it is checked against the record's, never silently overwritten and never silently trusted.
 */
export function resolvePdfToolSiteId(config: Pick<ProjectConnectionConfig, "projectId" | "objectDialect">, declared?: unknown): PdfToolSiteScope {
  const siteId = nonEmptyString(config.objectDialect?.siteObjectId) ? config.objectDialect!.siteObjectId.trim() : undefined;
  if (!siteId) {
    return {
      ok: false,
      code: "pdf_tool_site_id_unresolved",
      reason: `Project "${config.projectId}" declares no objectDialect.siteObjectId, so no pdf-tool call can be site-scoped for it and none was attempted. A genesis-minted tenant carries this from birth; repair an older record with \`npm run genesis:reconcile -- ${config.projectId} --apply\` (it fills unset dialect fields from the platform scaffold's own ids) rather than passing the tenantId as a stand-in — Platform refuses that with artifact_site_mismatch.`
    };
  }
  const declaredSiteId = nonEmptyString(declared) ? declared.trim() : undefined;
  if (declaredSiteId && declaredSiteId !== siteId) {
    return {
      ok: false,
      code: "pdf_tool_site_id_mismatch",
      reason: `This run names siteId "${declaredSiteId}" but project "${config.projectId}"'s own record scopes pdf-tool calls to "${siteId}". A run is never redirected to another site's template store; drop the siteId (it is resolved from the record) or correct the record.`
    };
  }
  return { ok: true, siteId };
}
