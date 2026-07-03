import type { RJSFSchema } from "@rjsf/utils";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

type SchemaViewerProps = {
  schema?: RJSFSchema;
  emptyMessage: string;
};

export function SchemaViewer({ schema, emptyMessage }: SchemaViewerProps) {
  return <pre>{schema ? pretty(schema) : emptyMessage}</pre>;
}
