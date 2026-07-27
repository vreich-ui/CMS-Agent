// The Glossary disclosure. The registry's content is tested by root vitest
// (tests/ui/explain.test.ts); this covers what only the DOM can answer: that definitions are
// reachable without a mouse, that they start collapsed so a surface stays calm, and that the raw
// code survives next to the plain-language label.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Glossary } from "../src/components/Glossary";

describe("Glossary", () => {
  it("starts collapsed, so a reader who knows the terms is not charged for them", () => {
    render(<Glossary id="risk" />);
    // The summary is always readable; the definitions are not rendered open.
    expect(screen.getByText("What do read, write, publish and admin mean?")).toBeInTheDocument();
    expect(screen.getByRole("group")).not.toHaveAttribute("open");
  });

  it("phrases the trigger as the question the reader would ask", () => {
    // GOV.UK's research: users skip disclosures whose trigger text does not say what is inside, and
    // some avoid them believing they navigate away.
    render(<Glossary id="denial" />);
    expect(screen.getByText("Why can a tool be denied?")).toBeInTheDocument();
  });

  // The accessibility claim is that explanation is reachable without a pointer — the whole reason
  // these definitions moved out of `title=` attributes. jsdom does not implement <summary> focus or
  // Enter/Space activation (tab lands on <body>), so asserting the keypress here would be testing
  // jsdom, not the product. What IS verifiable, and what actually guarantees the behaviour in a real
  // browser, is that the trigger is a native <summary> inside <details> rather than a div with an
  // onClick — native semantics are why no ARIA or key handling of our own is needed.
  it("uses native details/summary, which is what makes it keyboard-operable", () => {
    render(<Glossary id="execution" />);
    const group = screen.getByRole("group");

    expect(group.tagName).toBe("DETAILS");
    const trigger = group.firstElementChild;
    expect(trigger?.tagName).toBe("SUMMARY");
    // No hand-rolled interactivity that a keyboard user could be locked out of.
    expect(group.querySelector("[onclick]")).toBeNull();
    expect(group.querySelector("div[role='button']")).toBeNull();
  });

  it("carries no title attribute, the channel these definitions moved out of", () => {
    // title= fails touch, keyboard, screen-reader, fine-motor and cognitively-loaded users (MDN), and
    // this project's accessibility spec forbids hover as a sole channel. Regressing to it would be
    // silent, so it is asserted.
    render(<Glossary id="denial" />);
    const group = screen.getByRole("group");
    expect(group.hasAttribute("title")).toBe(false);
    expect(group.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("keeps the raw code beside the human label, so the UI still matches the docs", async () => {
    const user = userEvent.setup();
    render(<Glossary id="denial" />);
    await user.click(screen.getByText("Why can a tool be denied?"));

    const group = screen.getByRole("group");
    expect(within(group).getByText("risk_level_exceeds_authorization")).toBeInTheDocument();
    expect(within(group).getByText("Above the node's risk ceiling")).toBeInTheDocument();
  });

  it("surfaces the remedy, not just the diagnosis", async () => {
    const user = userEvent.setup();
    render(<Glossary id="denial" />);
    await user.click(screen.getByText("Why can a tool be denied?"));

    expect(screen.getByText(/Tick it in the Own column and save/)).toBeInTheDocument();
  });

  it("states the risk ceiling rule, which no other surface explains", async () => {
    const user = userEvent.setup();
    render(<Glossary id="risk" />);
    await user.click(screen.getByText("What do read, write, publish and admin mean?"));

    expect(screen.getByText(/A node's own risk level is the CEILING/)).toBeInTheDocument();
  });
});
