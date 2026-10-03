export type StoreErrorCode =
  | "invalid_path"
  | "insecure_location"
  | "schema_too_new"
  | "foreign_database"
  | "unsupported_journal_mode"
  | "bad_run_id"
  | "run_id_exhausted"
  | "bad_clock"
  | "corrupt_row";

/** Thrown for open-time and invariant failures. Input validation uses result values instead. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}
