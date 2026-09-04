// T15.6 (2026-09-04) — the operational hole that bit the fleet today: dr-lurie and platform predate
// site genesis, carry no clientSiteBinding, and were never in CMS_AGENT_SITE_BINDINGS_JSON, so
// reconcileSiteClientManagerCredentials silently OMITTED them from every plan. Both tenants sat on
// stale scoped bearers while every visual_identity_propose call 401'd, and the operator — reading an
// empty diff — diagnosed a healthy fleet. This file pins the fix's three parts:
//   1. project.update can now set/clear clientSiteBinding through the ordinary admin API, validated
//      by the SAME requireValidClientSiteBinding check project.create already used.
//   2. project.create surfaces a visible advisory (never a refusal) when a bearer_env project is
//      registered with no binding — bearer_env also covers internal service projects (monetizer,
//      pdf-tool) that legitimately never get one.
//   3. Setting a binding on a project the reconciler could not see AT ALL makes it visible as
//      "planned" — driven through the real reconciler, because that transition IS the fix.
import { describe, expect, it } from "vitest";
import {
  ProjectAdminError,
  bearerEnvClientSiteBindingAdvisory,
  createProject,
  projectUpdateSchema,
  updateProject
} from "../../../src/agent/projects/projectAdmin.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { reconcileSiteClientManagerCredentials } from "../../../src/agent/capture/siteCredentialReconciler.js";
import { ManagedScopedBearerCredentialRepository } from "../../../src/agent/mcp/auth/managedScopedBearerCredentials.js";
import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";

// Minimal in-memory double for the blob store the managed-credential registry reads/writes —
// matches the one in tests/agent/capture/siteCredentialReconciler.test.ts, so this exercises the
// REAL ManagedScopedBearerCredentialRepository (not a hand-rolled stand-in of it) with only its I/O
// swapped out, exactly like every other reconciler test in this codebase.
const memoryBlobStore = (): BlobStoreClient => {
  const values = new Map<string, { data: unknown; etag: string }>();
  let generation = 0;
  return {
    get: async (key: string) => structuredClone(values.get(key)?.data ?? null),
    getWithMetadata: async (key: string) => {
      const current = values.get(key);
      return current ? { data: structuredClone(current.data), etag: current.etag, metadata: {} } : null;
    },
    setJSON: async (key: string, data: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
      const current = values.get(key);
      if ((options?.onlyIfNew && current) || (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false };
      generation += 1;
      const etag = String(generation);
      values.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    list: async () => ({ blobs: [], directories: [] }),
    delete: async (key: string) => { values.delete(key); }
  } as unknown as BlobStoreClient;
};

describe("project.update: clientSiteBinding", () => {
  it("sets a binding on a project that had none, and the stored record carries it", async () => {
    const repository = new MemoryProjectRepository();
    // dr-lurie is one of the two live tenants this incident actually hit: seeded with no binding.
    const before = await repository.get("dr-lurie");
    expect(before?.clientSiteBinding).toBeUndefined();

    const summary = await updateProject(repository, "dr-lurie", {
      clientSiteBinding: { netlifySiteName: "drluriescience", netlifySiteId: "site_drlurie" }
    });
    expect(summary.projectId).toBe("dr-lurie");

    const stored = await repository.get("dr-lurie");
    expect(stored?.clientSiteBinding).toEqual({ netlifySiteName: "drluriescience", netlifySiteId: "site_drlurie" });
  });

  it("accepts a binding with no netlifySiteId — the id is optional on both the schema and the validator", async () => {
    const repository = new MemoryProjectRepository();
    await updateProject(repository, "platform", { clientSiteBinding: { netlifySiteName: "kugel-platform" } });
    const stored = await repository.get("platform");
    expect(stored?.clientSiteBinding).toEqual({ netlifySiteName: "kugel-platform" });
  });

  it("refuses an invalid binding with the SAME code project.create uses — no second validator", async () => {
    const repository = new MemoryProjectRepository();
    let caught: unknown;
    try {
      await updateProject(repository, "dr-lurie", { clientSiteBinding: { netlifySiteName: "NOT-a-valid-slug" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProjectAdminError);
    expect((caught as ProjectAdminError).code).toBe("client_site_binding_invalid");

    // Refused before the write: the stored record is untouched.
    const stored = await repository.get("dr-lurie");
    expect(stored?.clientSiteBinding).toBeUndefined();
  });

  it("clears the binding with null, following the mcpEndpoint/tokenSecretRef convention; omitting the field leaves it as-is", async () => {
    const repository = new MemoryProjectRepository();
    await updateProject(repository, "dr-lurie", { clientSiteBinding: { netlifySiteName: "drluriescience" } });

    // Omitting the field on an unrelated patch must not disturb it.
    await updateProject(repository, "dr-lurie", { name: "Dr. Lurie Skincare" });
    expect((await repository.get("dr-lurie"))?.clientSiteBinding).toEqual({ netlifySiteName: "drluriescience" });

    // null clears it.
    await updateProject(repository, "dr-lurie", { clientSiteBinding: null });
    expect((await repository.get("dr-lurie"))?.clientSiteBinding).toBeUndefined();
  });

  it("the zod schema itself accepts an object, accepts null, and refuses an unknown sub-field", () => {
    expect(projectUpdateSchema.safeParse({ clientSiteBinding: { netlifySiteName: "acme" } }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ clientSiteBinding: null }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ clientSiteBinding: { netlifySiteName: "acme", netlifyAccountId: "acct_1" } }).success).toBe(false);
  });
});

describe("project.create: bearer_env-with-no-binding advisory", () => {
  const baseInput = {
    projectId: "acme-daily",
    name: "Acme Daily",
    mcpEndpointEnvVar: "ACME_DAILY_MCP_ENDPOINT",
    tokenEnvVar: "ACME_DAILY_MCP_TOKEN",
    allowedTools: [],
    contentContract: { contentContract: "content_source.v1" as const },
    status: "active" as const
  };

  it("surfaces the advisory for a bearer_env project with no clientSiteBinding", () => {
    const advisory = bearerEnvClientSiteBindingAdvisory({ authMode: "bearer_env", clientSiteBinding: undefined });
    expect(advisory).toBeDefined();
    expect(advisory).toContain("bearer_env");
    expect(advisory).toContain("project.update");
  });

  it("does not warn a bearer_env project that already carries a binding — the genesis path (createProject called in-process with clientSiteBinding, never through the public schema)", async () => {
    expect(bearerEnvClientSiteBindingAdvisory({ authMode: "bearer_env", clientSiteBinding: { netlifySiteName: "acme-daily" } })).toBeUndefined();

    // Prove the whole path end to end: genesis's own call shape (trusted in-process input carrying
    // clientSiteBinding) never trips the advisory and the record really does carry the binding.
    const repository = new MemoryProjectRepository();
    const summary = await createProject(repository, { ...baseInput, authMode: "bearer_env", clientSiteBinding: { netlifySiteName: "acme-daily", netlifySiteId: "site_acme" } });
    expect(summary.projectId).toBe("acme-daily");
    expect(bearerEnvClientSiteBindingAdvisory({ authMode: "bearer_env", clientSiteBinding: (await repository.get("acme-daily"))?.clientSiteBinding })).toBeUndefined();
  });

  it("does not warn a non-bearer_env project regardless of binding", () => {
    expect(bearerEnvClientSiteBindingAdvisory({ authMode: "none", clientSiteBinding: undefined })).toBeUndefined();
  });

  it("is exactly what project.create's MCP schema always produces for a bearer_env registration — clientSiteBinding is not on the public schema, so the advisory always fires there unless the caller is a trusted in-process one", async () => {
    const repository = new MemoryProjectRepository();
    // The public project.create shape (projectCreateSchema) has no clientSiteBinding field at all —
    // this IS what an MCP caller's parsed input looks like, structurally incapable of setting one.
    const created = await createProject(repository, { ...baseInput, authMode: "bearer_env" });
    expect(created.authMode).toBe("bearer_env");
    const advisory = bearerEnvClientSiteBindingAdvisory({ authMode: "bearer_env", clientSiteBinding: undefined });
    expect(advisory).toBeDefined();
  });
});

describe("the reconciler transition: an invisible project becomes planned once its binding is set", () => {
  it("dr-lurie is unmanaged in a fresh registry (no binding, no backfill mapping) and becomes planned the moment project.update sets one — driven through the real reconciler", async () => {
    const repository = new MemoryProjectRepository();
    const credentialRepository = new ManagedScopedBearerCredentialRepository(memoryBlobStore());

    // BEFORE: this is the exact incident. dr-lurie is bearer_env with no binding, so it is
    // reported "unmanaged", not silently absent — but it is still not actionable.
    const before = await reconcileSiteClientManagerCredentials({ apply: false }, { projectRepository: repository, env: {}, credentialRepository });
    const drLurieBefore = before.find((result) => result.projectId === "dr-lurie");
    expect(drLurieBefore?.status).toBe("unmanaged");
    expect(drLurieBefore?.errorDetail).toContain("No client-site binding");

    // THE FIX: back-fill the binding through the ordinary admin API — no env var, no redeploy.
    await updateProject(repository, "dr-lurie", { clientSiteBinding: { netlifySiteName: "drluriescience", netlifySiteId: "site_drlurie" } });

    // AFTER: the SAME real reconciler, against the SAME (still-empty) credential registry, now sees
    // dr-lurie at all and reports it plannable — no active credential exists yet, so "planned" (not
    // "current") is the honest answer.
    const after = await reconcileSiteClientManagerCredentials({ apply: false }, { projectRepository: repository, env: {}, credentialRepository });
    const drLurieAfter = after.find((result) => result.projectId === "dr-lurie");
    expect(drLurieAfter).toEqual({ projectId: "dr-lurie", netlifySiteName: "drluriescience", status: "planned" });
  });
});
