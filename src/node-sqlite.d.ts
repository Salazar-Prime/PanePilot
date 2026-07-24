declare module 'node:sqlite' {
  type SqlValue = string | number | bigint | null | Uint8Array

  interface StatementSync {
    all(...anonymousParameters: SqlValue[]): unknown[]
    get(...anonymousParameters: SqlValue[]): unknown
    run(...anonymousParameters: SqlValue[]): {
      changes: number | bigint
      lastInsertRowid: number | bigint
    }
  }

  export class DatabaseSync {
    constructor(path: string)
    close(): void
    exec(sql: string): void
    prepare(sql: string): StatementSync
  }
}
