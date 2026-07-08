export interface RecordEnvelope<T> {
  id: string;
  record_type: string;
  schema_version: string;
  created_at: string;
  updated_at: string;
  data: T;
}
