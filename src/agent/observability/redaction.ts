// Shared recursive key-based redaction for values that get persisted or returned by tools.
// Values under credential-looking keys are replaced with "[REDACTED]"; all other values —
// including prompt text, which lives under a non-sensitive key — pass through untouched.
const sensitiveKeyPattern = /secret|token|api[_-]?key|authorization|password|cookie/i;

export const redactSensitiveKeys = <T>(value: T): T =>
  value === undefined
    ? value
    : JSON.parse(JSON.stringify(value, (key, val) => (sensitiveKeyPattern.test(key) ? "[REDACTED]" : val)));
