declare module "better-sqlite3" {
  interface Statement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(sql: string): void;
    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
    close(): void;
  }

  interface DatabaseConstructor {
    new (filename: string): Database;
  }

  const BetterSqlite3: DatabaseConstructor;
  export default BetterSqlite3;
}

declare module "adm-zip" {
  export interface IZipEntry {
    entryName: string;
    getData(): Buffer;
  }

  export default class AdmZip {
    constructor(file?: string | Buffer);
    getEntries(): IZipEntry[];
    extractAllTo(targetPath: string, overwrite?: boolean): void;
  }
}

declare module "html-to-text" {
  export interface ConvertOptions {
    wordwrap?: number | false;
    selectors?: Array<{ selector: string; format: string }>;
  }

  export function convert(value: string, options?: ConvertOptions): string;
}

declare module "moving-averages" {
  export function ema(values: number[], smoothingFactor: number): number[];
}
