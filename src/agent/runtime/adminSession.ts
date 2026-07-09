import type { HeaderMap } from "./auth.js";

export type NetlifyIdentityUser = {
  email?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
};

export type NetlifyFunctionContext = {
  clientContext?: { user?: NetlifyIdentityUser | null } | null;
};

export type AdminSession = { authenticated: true; authorized: true; email: string };

export class AdminSessionError extends Error {
  constructor(public readonly statusCode: 401 | 403, public readonly code: "unauthenticated" | "forbidden", message: string, public readonly email?: string) {
    super(message);
  }
}

const parseAdminEmails = (value: string | undefined) => new Set((value ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));

export function getIdentityEmail(context: NetlifyFunctionContext): string | undefined {
  const email = context.clientContext?.user?.email;
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : undefined;
}

export function requireAdminSession(context: NetlifyFunctionContext, env: NodeJS.ProcessEnv = process.env): AdminSession {
  const email = getIdentityEmail(context);
  if (!email) throw new AdminSessionError(401, "unauthenticated", "Netlify Identity login is required.");

  const adminEmails = parseAdminEmails(env.ADMIN_EMAIL_IDS);
  if (!adminEmails.has(email)) throw new AdminSessionError(403, "forbidden", "Logged-in user is not authorized for this workspace.", email);

  return { authenticated: true, authorized: true, email };
}

export const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

export function adminSessionErrorResponse(error: AdminSessionError) {
  return json(error.statusCode, {
    authenticated: error.statusCode !== 401,
    authorized: false,
    ...(error.email ? { email: error.email } : {}),
    error: { code: error.code, message: error.message }
  });
}

export type FunctionEvent = { httpMethod: string; body: string | null; headers: HeaderMap; blobs?: string };
