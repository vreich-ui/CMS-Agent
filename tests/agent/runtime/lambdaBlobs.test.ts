import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectLambda } = vi.hoisted(() => ({ connectLambda: vi.fn(() => undefined) }));

vi.mock("@netlify/blobs", () => ({ connectLambda }));

import { connectLambdaBlobs, hasLambdaBlobsContext } from "../../../src/agent/runtime/lambdaBlobs.js";

const withBlobs = { blobs: "eyJ0b2tlbiI6InNlY3JldCJ9", headers: { "x-nf-site-id": "site" } };

describe("connectLambdaBlobs", () => {
  beforeEach(() => connectLambda.mockReset());

  it("connects when the event carries a Blobs context", () => {
    connectLambdaBlobs(withBlobs);
    expect(connectLambda).toHaveBeenCalledTimes(1);
    expect(connectLambda).toHaveBeenCalledWith(withBlobs);
  });

  it("skips connecting when there is no Blobs context (memory/dev/test)", () => {
    connectLambdaBlobs({ headers: { authorization: "Bearer x" } });
    connectLambdaBlobs({ blobs: "", headers: {} });
    connectLambdaBlobs(undefined);
    expect(connectLambda).not.toHaveBeenCalled();
  });

  it("never leaks the underlying error (which can echo decoded token bytes)", () => {
    connectLambda.mockImplementationOnce(() => {
      throw new Error('Unexpected token in JSON: {"token":"super-secret-token"}');
    });
    expect(() => connectLambdaBlobs(withBlobs)).toThrowError("Failed to initialize the Netlify Blobs Lambda context.");
    try {
      connectLambda.mockImplementationOnce(() => {
        throw new Error('super-secret-token');
      });
      connectLambdaBlobs(withBlobs);
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret-token");
    }
  });

  it("hasLambdaBlobsContext narrows only real Lambda Blobs events", () => {
    expect(hasLambdaBlobsContext(withBlobs)).toBe(true);
    expect(hasLambdaBlobsContext({ headers: {} })).toBe(false);
    expect(hasLambdaBlobsContext({ blobs: "ctx" })).toBe(false);
    expect(hasLambdaBlobsContext(null)).toBe(false);
  });
});
