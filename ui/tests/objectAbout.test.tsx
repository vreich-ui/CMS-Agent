// The "what is this thing?" disclosure. The descriptions themselves are tested by root vitest
// (tests/ui/objectModel.test.ts, including that every tool they cite really exists); this covers the
// DOM contract.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ObjectAbout } from "../src/components/ObjectAbout";

describe("ObjectAbout", () => {
  it("names the object in the trigger, so the reader knows what is inside", () => {
    render(<ObjectAbout id="node" />);
    expect(screen.getByText("What is a node?")).toBeInTheDocument();
    expect(screen.getByRole("group")).not.toHaveAttribute("open");
  });

  it("answers why it exists, how it is identified, its lifecycle and its relations", async () => {
    const user = userEvent.setup();
    render(<ObjectAbout id="run" />);
    await user.click(screen.getByText("What is a run?"));

    const group = screen.getByRole("group");
    for (const label of ["Why it exists", "Identified by", "Lifecycle", "Relates to"]) {
      expect(within(group).getByText(label)).toBeInTheDocument();
    }
  });

  it("surfaces the trap prominently rather than as one more muted line", async () => {
    const user = userEvent.setup();
    render(<ObjectAbout id="run" />);
    await user.click(screen.getByText("What is a run?"));

    // blocked vs failed is the distinction that costs people the most time on a run.
    expect(screen.getByText(/Worth knowing:/)).toBeInTheDocument();
    expect(screen.getByText(/deliberate safety hold/)).toBeInTheDocument();
  });

  it("names the engine type, so the docs and the code stay connected", async () => {
    const user = userEvent.setup();
    render(<ObjectAbout id="node" />);
    await user.click(screen.getByText("What is a node?"));

    expect(screen.getByText("WorkspaceNode")).toBeInTheDocument();
  });

  it("renders nothing for an unknown object rather than an empty shell", () => {
    // A surface asking for a description that does not exist should degrade to silence, not to a
    // disclosure that opens onto blank fields.
    const { container } = render(<ObjectAbout id="not_a_real_object" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("uses native details/summary, which is what makes it keyboard-operable", () => {
    render(<ObjectAbout id="project" />);
    const group = screen.getByRole("group");
    expect(group.tagName).toBe("DETAILS");
    expect(group.firstElementChild?.tagName).toBe("SUMMARY");
    expect(group.querySelectorAll("[title]")).toHaveLength(0);
  });
});
