// Safe, non-secret guidance derived from Platform's committed Fernwell site and seed data.
export const fernwellProjectKnowledge = {
  projectId: "fernwell",
  sources: ["/sites/fernwell/config/site-identity.ts", "/sites/fernwell/seeds/voice-seed-data.mjs", "/sites/fernwell/seeds/taxonomy-seed-data.mjs"],
  rules: {
    identity: ["The owning site object is site_fernwell.", "The taxonomy registry is tax_fernwell.", "The editorial voice singleton is voice_fernwell."],
    objectSubstrate: ["Content is represented as governed objects; the client's live object_contract is the source of truth.", "Use the object lifecycle and the client's own object_validate result; never invent a client shape."],
    publishing: ["Publishing and release are separate gates.", "A ready-but-undeployed build is not live; verify the serving deploy before claiming go-live."],
    safety: ["Fernwell is a general-audience houseplant-care brand, not medical, legal, or financial guidance.", "Avoid hype, scarcity, unsupported comparative claims, and invented taxonomy terms."]
  }
} as const;
