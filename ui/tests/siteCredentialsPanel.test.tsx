import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SiteCredentialsPanel } from "../src/components/SiteCredentialsPanel";
import type { useSiteCredentials } from "../src/hooks/useSiteCredentials";
import type { SiteCredentialPlan } from "../src/types/workspace";

type SiteCredentialsHook = ReturnType<typeof useSiteCredentials>;

const plan = (staleCount: number): SiteCredentialPlan => ({
  mode: "dry_run",
  staleCount,
  results: [
    { projectId: "dr-lurie", netlifySiteName: "dr-lurie-skincare", status: staleCount > 0 ? "planned" : "current" },
    { projectId: "kugel-platform", netlifySiteName: "kugel-platform", status: "current" }
  ]
});

const baseHook = (overrides: Partial<SiteCredentialsHook> = {}): SiteCredentialsHook => ({
  plan: null,
  planLoading: false,
  planError: null,
  refreshPlan: vi.fn(async () => plan(0)),
  executionName: null,
  jobName: null,
  execution: null,
  applying: false,
  applyError: null,
  apply: vi.fn(async () => ({ executionName: "exec_1", jobName: "reconcile-site-credentials" })),
  ...overrides
});

const noop = () => {};

describe("SiteCredentialsPanel", () => {
  it("renders each tenant's status and a fleet-wide 'all current' summary", () => {
    render(<SiteCredentialsPanel siteCredentials={baseHook({ plan: plan(0) })} onStatus={noop} onError={noop} />);

    expect(screen.getByText(/All tenants current/i)).toBeInTheDocument();
    expect(screen.getByText("dr-lurie-skincare")).toBeInTheDocument();
    expect(screen.getAllByText("Current")).toHaveLength(2);
  });

  it("renders a stale tenant's status and the fleet 'needs repair' summary", () => {
    render(<SiteCredentialsPanel siteCredentials={baseHook({ plan: plan(1) })} onStatus={noop} onError={noop} />);

    expect(screen.getByText("1 tenant needs repair.")).toBeInTheDocument();
    expect(screen.getByText("Needs repair")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("disables apply when staleCount is 0, with the reason visible", () => {
    render(<SiteCredentialsPanel siteCredentials={baseHook({ plan: plan(0) })} onStatus={noop} onError={noop} />);

    const button = screen.getByRole("button", { name: /repair stale tenants/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/nothing to repair/i)).toBeInTheDocument();
  });

  it("enables apply when at least one tenant is stale, but requires an explicit confirmation step before firing", async () => {
    const user = userEvent.setup();
    const apply = vi.fn(async () => ({ executionName: "exec_1", jobName: "reconcile-site-credentials" }));
    render(<SiteCredentialsPanel siteCredentials={baseHook({ plan: plan(1), apply })} onStatus={noop} onError={noop} />);

    const startButton = screen.getByRole("button", { name: /repair stale tenants/i });
    expect(startButton).toBeEnabled();

    await user.click(startButton);
    // Clicking once must not have fired apply — it opens a confirmation instead.
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByText(/rotates live credentials and republishes production sites/i)).toBeInTheDocument();

    const confirmButton = screen.getByRole("button", { name: /confirm repair/i });
    await user.click(confirmButton);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("lets the confirmation be cancelled without firing apply", async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    render(<SiteCredentialsPanel siteCredentials={baseHook({ plan: plan(1), apply })} onStatus={noop} onError={noop} />);

    await user.click(screen.getByRole("button", { name: /repair stale tenants/i }));
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /repair stale tenants/i })).toBeInTheDocument();
  });

  it("states the 10-20 minute rebuild cost before any click, not just after", () => {
    render(<SiteCredentialsPanel siteCredentials={baseHook({ plan: plan(1) })} onStatus={noop} onError={noop} />);
    expect(screen.getByText(/10-20 minutes/)).toBeInTheDocument();
  });

  it("surfaces a partly-failed execution — not swallowed — and points at Cloud Run", () => {
    render(<SiteCredentialsPanel siteCredentials={baseHook({
      plan: plan(2),
      executionName: "exec_9",
      jobName: "reconcile-site-credentials",
      execution: { state: "SUCCEEDED", succeededCount: 1, failedCount: 1 }
    })} onStatus={noop} onError={noop} />);

    expect(screen.getByText(/Repair finished with 1 failure/i)).toBeInTheDocument();
    expect(screen.getByText(/1 tenant repaired, 1 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/execution log in Cloud Run \(job reconcile-site-credentials\)/i)).toBeInTheDocument();
  });

  it("shows in-progress polling state while applying", () => {
    render(<SiteCredentialsPanel siteCredentials={baseHook({
      plan: plan(1),
      applying: true,
      executionName: "exec_9",
      jobName: "reconcile-site-credentials",
      execution: { state: "ACTIVE" }
    })} onStatus={noop} onError={noop} />);

    expect(screen.getByText(/Repair in progress — ACTIVE/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /repair in progress…/i })).toBeDisabled();
  });
});
