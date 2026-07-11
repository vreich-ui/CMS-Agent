// Shared status-banner message shape, extracted so page components and App can exchange status
// callbacks without importing each other.
export type StatusMessage = { tone: "info" | "success" | "error"; message: string };
