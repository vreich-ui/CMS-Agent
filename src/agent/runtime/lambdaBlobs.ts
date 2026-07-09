import { connectLambda } from "@netlify/blobs";

// Netlify runs these functions as Lambda-style handlers. In Lambda compatibility mode
// @netlify/blobs needs connectLambda(event) to populate the Blobs environment (site ID and
// access token, carried in the base64-encoded `event.blobs` context) before any getStore()
// call. Without it, getStore() throws MissingBlobsEnvironmentError. We connect only when the
// invocation actually carries a Blobs context, so memory/dev/test invocations (which have no
// `event.blobs`) are left untouched.
export type LambdaBlobsEvent = { blobs?: unknown; headers?: unknown };

export const hasLambdaBlobsContext = (
  event: LambdaBlobsEvent | null | undefined
): event is { blobs: string; headers: Record<string, string> } =>
  typeof event?.blobs === "string" && event.blobs.length > 0 && typeof event.headers === "object" && event.headers !== null;

// The decoded Blobs context holds an access token, so a decode/parse failure is surfaced as a
// generic error — the original message (which can echo decoded token bytes) is never propagated
// or logged.
export const connectLambdaBlobs = (event: LambdaBlobsEvent | null | undefined): void => {
  if (!hasLambdaBlobsContext(event)) return;
  try {
    connectLambda(event);
  } catch {
    throw new Error("Failed to initialize the Netlify Blobs Lambda context.");
  }
};
