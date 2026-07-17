import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishReadinessPanel } from "../src/components/PublishReadinessPanel";
import type { PublishReadinessResponse, PublishResult, WorkflowExecutionRecord } from "../src/types/workspace";

const run = { runId: "run_1", projectId: "dr-lurie" } as unknown as WorkflowExecutionRecord;

const goReadiness: PublishReadinessResponse = {
  available: true,
  articleBodyValid: true,
  readiness: {
    status: "go",
    state: "ready_for_publish_execution",
    checklist: [
      { key: "article_body_valid", label: "article_body.v1 valid", status: "pass" },
      { key: "taxonomy", label: "Taxonomy resolved", status: "accepted_empty", detail: "explicitly accepted empty" }
    ],
    blockers: [],
    hardConstraints: { contentPath: "article_body.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false }
  }
};

const noGoReadiness: PublishReadinessResponse = {
  available: true,
  articleBodyValid: false,
  readiness: {
    status: "no_go",
    state: "blocked_for_publish_execution",
    checklist: [
      { key: "pinned_approval", label: "Pinned approval present", status: "fail", detail: "no pinned approval on the publish request" }
    ],
    blockers: ["pinned_approval"],
    requiredAction: "Resolve: pinned_approval.",
    hardConstraints: { contentPath: "article_body.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false }
  }
};

const blockedResult: PublishResult = {
  published: false,
  mode: "blocked_for_publish_execution",
  gates: { operatorEnabled: false, approved: false, live: false, allPassed: false, gates: [{ name: "operator_enabled", passed: false, reason: "not enabled" }] },
  plan: { projectId: "dr-lurie", requestId: "req_flow_topic_20260717_01", nodeCount: 1, publishedTime: null, toolSequence: ["create_draft", "checkout"] },
  steps: [],
  readiness: noGoReadiness.readiness!,
  blocked: { requestId: "req_flow_topic_20260717_01", nodeAwaitingApproval: "publication_controller", artifactSlot: "node:n_img/public.media", requiredAction: "Resolve: media_artifacts_verified.", resumable: true }
};

const noop = () => {};

describe("PublishReadinessPanel", () => {
  it("shows an empty state until a run is selected", () => {
    render(<PublishReadinessPanel run={null} readiness={null} publishResult={null} loading={false} error={null} onCheckReadiness={noop} onPublish={noop} />);
    expect(screen.getByText(/No dry-run selected yet/i)).toBeInTheDocument();
  });

  it("renders a GO readiness checklist with the canonical hard constraints", () => {
    render(<PublishReadinessPanel run={run} readiness={goReadiness} publishResult={null} loading={false} error={null} onCheckReadiness={noop} onPublish={noop} />);
    expect(screen.getByText(/GO — ready for publish execution/i)).toBeInTheDocument();
    expect(screen.getByText("article_body.v1 valid")).toBeInTheDocument();
    // Hard-constraints block renders (dt labels are unique to the readiness result).
    expect(screen.getByText("artifactProtocol")).toBeInTheDocument();
    expect(screen.getByText("legacyFallbacksUsed")).toBeInTheDocument();
  });

  it("renders a readiness NO-GO as an amber safety hold, not a red error", () => {
    render(<PublishReadinessPanel run={run} readiness={noGoReadiness} publishResult={null} loading={false} error={null} onCheckReadiness={noop} onPublish={noop} />);
    const banner = screen.getByText(/NO-GO — safety hold/i).closest(".status");
    expect(banner).toHaveClass("safety");
    expect(banner).not.toHaveClass("error");
    expect(screen.getByText("Resolve: pinned_approval.")).toBeInTheDocument();
  });

  it("presents a blocked publish as a resumable safety hold exposing every operator field", async () => {
    const onPublish = vi.fn();
    render(<PublishReadinessPanel run={run} readiness={null} publishResult={blockedResult} loading={false} error={null} onCheckReadiness={noop} onPublish={onPublish} />);

    const hold = screen.getByText(/Publish paused — safety hold/i).closest(".status");
    expect(hold).toHaveClass("safety");
    expect(hold).not.toHaveClass("error");
    expect(screen.getByText("req_flow_topic_20260717_01")).toBeInTheDocument();
    expect(screen.getByText("publication_controller")).toBeInTheDocument();
    expect(screen.getByText("node:n_img/public.media")).toBeInTheDocument();
    expect(screen.getByText("Resolve: media_artifacts_verified.")).toBeInTheDocument();

    // Resumable: the retry button re-attempts the publish.
    await userEvent.click(screen.getByRole("button", { name: "Retry / resume" }));
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("builds the readiness input from the form when checking readiness", async () => {
    const user = userEvent.setup();
    const onCheckReadiness = vi.fn();
    render(<PublishReadinessPanel run={run} readiness={null} publishResult={null} loading={false} error={null} onCheckReadiness={onCheckReadiness} onPublish={noop} />);

    await user.selectOptions(screen.getByLabelText(/Release \/ build behavior/i), "publish_now");
    await user.type(screen.getByLabelText(/Approver/i), "editor");
    await user.click(screen.getByLabelText(/Pin approval/i));
    await user.click(screen.getByLabelText(/Accept empty taxonomy/i));
    await user.click(screen.getByLabelText(/Affirm hard constraints/i));
    await user.click(screen.getByRole("button", { name: "Check readiness" }));

    expect(onCheckReadiness).toHaveBeenCalledWith({
      releaseBehavior: "publish_now",
      taxonomy: { acceptedEmpty: true },
      approval: { pinned: true, approvedBy: "editor" },
      hardConstraints: { contentPath: "article_body.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false }
    });
  });

  it("gates publish on a request id, then forwards the explicit approved/live flags", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();
    render(<PublishReadinessPanel run={run} readiness={null} publishResult={null} loading={false} error={null} onCheckReadiness={noop} onPublish={onPublish} />);

    const publishButton = screen.getByRole("button", { name: /Attempt publish/i });
    expect(publishButton).toBeDisabled();

    await user.type(screen.getByLabelText(/Request id/i), "req_flow_topic_20260717_01");
    await user.click(screen.getByLabelText(/^approved$/i));
    await user.click(screen.getByLabelText(/^live/i));
    await user.click(screen.getByRole("button", { name: "Publish live" }));

    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req_flow_topic_20260717_01", approved: true, live: true }));
  });
});
