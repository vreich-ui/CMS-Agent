// Some MCP clients serialize object-typed arguments as JSON strings rather than nested objects
// (observed live with Claude's connector, and again in T-2/tool.test: an untyped `input: {}` wire
// schema gives the client no signal to send an object, so it sends the JSON text instead). For a
// value that is contractually an object/array, parse a string that contains one; anything else
// passes through unchanged so downstream schema validation reports the real shape error.
export const coerceJsonObjectInput = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};
