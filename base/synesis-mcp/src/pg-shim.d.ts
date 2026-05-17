/** Minimal typings for `pg` (avoid @types/pg lockfile drift in standalone mcp-ts tree). */
declare module "pg" {
  export interface QueryResult<T = unknown> {
    rows: T[];
    rowCount: number | null;
  }

  export class Pool {
    constructor(config?: Record<string, unknown>);
    query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
    end(): Promise<void>;
  }
}
