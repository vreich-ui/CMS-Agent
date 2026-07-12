# CMS-Agent Product Vision

Reread this document before every working session. It anchors every design
and engineering decision. Session plans, specs, and reviews should defer to
it; where an older document disagrees with this one, this one wins.

CMS-Agent is an MCP-backed operational workspace for autonomous AI
organizations.

This is not another workflow editor. It is an operating system for
supervising, understanding, improving and safely evolving autonomous agent
teams.

The majority of configuration changes will eventually be made by other
trusted agents through MCP. Human users become supervisors, architects,
reviewers and exception handlers rather than primary operators. Every design
decision should support that future.

## Product philosophy

CMS-Agent should optimize for **attention, not information density**. The
limiting factor for human operators is cognitive load.

Never ask: "Can we display this information?"
Instead ask: "Does this information deserve attention right now?"

Healthy systems should disappear into the background. Problems, bottlenecks,
changes and decisions should naturally rise to the surface. Everything else
should remain discoverable through progressive disclosure.

The UI should feel calm. Not empty. Not simplistic. Calm.

## Mental model

The current workflow graph is only one representation of the system. The
real system consists of:

Projects → Missions → Workflows → Agent Teams → Agents → Runs → Knowledge → History

The graph is only one view into that organization. **Do not make the graph
the product.**

## Product identity

GitHub became the operating system for software projects. CMS-Agent should
become the operating system for autonomous organizations.

The user should feel like they are supervising a living organization rather
than editing a flowchart.

## Primary user questions

Every screen should help answer one or more of these questions:

- What is happening?
- What changed?
- Why did it happen?
- Who influenced whom?
- Where is attention needed?
- Can I trust this system?
- Can I safely change it?
- Can I restore a previous state?

## Core UX principle

Reduce context switching. Selecting something should reveal more
information. It should almost never navigate away. The user should remain
oriented at all times. The workspace should preserve spatial memory.

## Attention hierarchy

The interface should continuously separate information into four layers.

**Layer 1 — Requires immediate action.**
Failed runs, blocked approvals, configuration conflicts, policy violations,
critical cost spikes.

**Layer 2 — Needs awareness.**
Recent agent changes, degrading performance, quality drift, new memories,
relationship changes.

**Layer 3 — Useful operational information.**
Runs, usage, relationships, analytics.

**Layer 4 — Configuration.**
Schemas, prompts, tools, permissions, memory, advanced settings.

Humans should spend most of their time in Layers 1 and 2.

## Progressive disclosure

The default interface should be intentionally minimal. Every additional
detail should require deliberate exploration.

Never overwhelm users with schemas, JSON, technical IDs, timestamps, or raw
metadata. Show them only when they become relevant.

## Constellation

The graph becomes the Constellation. It represents an organization rather
than a workflow.

The Constellation has three conceptual modes:

- **Design** — structure, relationships, capabilities.
- **Operate** — health, cost, interaction, influence.
- **History** — evolution, changes, restoration.

The same graph should answer different questions depending on the mode
rather than becoming three separate products.

## Agent representation

Nodes should remain intentionally simple: name, ID, short description,
role. Everything else belongs elsewhere.

Editing an agent should happen in a focused configuration experience.
Configuration complexity should never leak into the graph.

## Relationships

Relationships are as important as agents. They represent execution, data,
memory, policy, evaluation, and human approval.

Over time the constellation should become capable of visualizing
organizational behavior instead of only execution order.

Relationship strength should communicate interaction frequency. Not every
relationship should be visible simultaneously. Users should be able to
focus on one relationship layer at a time.

## Explainability

The system should always explain observable behavior. Never invent hidden
reasoning. When something is highlighted the interface should also explain
why.

Examples:

- High attention because retries increased.
- High cost because Research generated 41% more tokens.
- Review quality decreased after prompt revision 28.

Every insight should be supported by observable evidence.

## History

History is a first-class feature. Everything important should be
attributable. Every change should answer:

- Who changed it?
- Why?
- When?
- What changed?
- What happened afterwards?

Restoration never deletes history. Restoring creates another historical
event.

## Human and agent collaboration

Agents are first-class contributors. Humans are also first-class
contributors. The UI should never assume humans authored every change.

Every mutation should clearly identify whether it originated from: human,
agent, system, MCP, migration, or automation.

## Editing philosophy

Humans edit rarely. When they do edit they should feel confident. Editing
should encourage understanding before modification.

Configuration should be grouped conceptually rather than technically. Large
editing surfaces are preferable to many small disconnected dialogs. Unsaved
work should always be respected. Conflicts should always be understandable.

## Analytics philosophy

Analytics exist to support decisions. Do not build dashboards full of
numbers. Every metric should help answer a question. Every visualization
should justify its existence.

Whenever possible analytics should connect directly back to agents,
relationships, runs, changes, and missions rather than existing
independently.

## The missing perspective

One unique capability CMS-Agent should grow into is organizational
understanding.

Traditional workflow editors answer: "What executes next?"

CMS-Agent should also answer:

- "Who influences whom?"
- "Which teams collaborate most?"
- "Where does knowledge accumulate?"
- "What organizational changes improved quality?"
- "What became a bottleneck?"

This perspective should gradually become one of the defining
characteristics of the product.

## Visual language

Modern. Quiet. High information quality. Low visual noise. Whitespace
should be used intentionally.

Healthy systems should almost disappear. Attention should naturally
gravitate toward exceptions.

Avoid heavy card layouts. Avoid unnecessary borders. Avoid decorative
colors. Color should communicate meaning.

## Design inspiration

- **GitHub** — repository selector, navigation stability, history, trust.
- **VS Code** — persistent workspace, explorer, editor, bottom panel.
- **OpenAI Agent Builder** — focused editing, minimal graph, configuration model.
- **Linear** — hierarchy, density, typography.
- **Figma** — selection model, inspector philosophy, spatial memory.

Do not imitate any of them directly. Combine their strongest interaction
ideas into something unique for CMS-Agent.

## Engineering philosophy

Do not rewrite working systems without reason. Preserve MCP as the source
of truth. Keep components composable. Prefer adapters over breaking
migrations. Favor evolvability over cleverness. Think in years rather than
releases.

Avoid local optimizations that make future organizational visualization
harder.

## Working method

For every implementation cycle: first understand, then simplify, then
design, then implement, then validate.

Before writing code ask: "What problem is this solving?"
After writing code ask: "Does this reduce cognitive load?"
If not, rethink the solution.

## Long-term vision

The end goal is not a better workflow builder.

The end goal is an operating environment where a human can open CMS-Agent
after several days away and, within a minute, understand:

- what the autonomous organization accomplished,
- what changed,
- where attention is required,
- why the system behaved the way it did,
- what should be improved next,

and confidently make or approve changes.

Every implementation should move the product toward that vision, even if
only incrementally.
