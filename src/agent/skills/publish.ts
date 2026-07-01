import { z } from "zod";
import type { ProjectProfile } from "../runtime/types.js";

export const publishParamsSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  dryRun: z.boolean().optional().default(true)
});

export async function publishContent(params: z.infer<typeof publishParamsSchema>, project: ProjectProfile) {
  const parsed = publishParamsSchema.parse(params);
  if (parsed.dryRun !== false) {
    return { dryRun: true, published: false, status: "dry_run", target: project.publishingTarget.type };
  }

  if (project.publishingTarget.type !== "http") {
    return { dryRun: false, published: false, status: "no_publish_target" };
  }

  const endpoint = project.publishingTarget.endpointEnv ? process.env[project.publishingTarget.endpointEnv] : undefined;
  if (!endpoint) throw new Error("Publishing endpoint is not configured");

  const token = project.publishingTarget.tokenEnv ? process.env[project.publishingTarget.tokenEnv] : undefined;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ title: parsed.title, content: parsed.content })
  });

  return { dryRun: false, published: response.ok, status: response.ok ? "published" : "publish_failed", statusCode: response.status };
}
