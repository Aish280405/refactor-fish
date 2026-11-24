export type FsOpKind = "read" | "write" | "rename" | "remove" | "mkdir";

export interface FsOp {
  op: FsOpKind;
  path: string;
  /** Destination path for `rename`. */
  to?: string;
}

/**
 * In-memory filesystem that records every operation. Inject it wherever code
 * takes a file-system dependency, then assert on `ops`, `writes()` and
 * `writesOutside()`, or compare `snapshot()` before and after.
 */
export class InMemoryFsSpy {
  readonly ops: FsOp[] = [];
  private readonly files = new Map<string, string>();
  private failNextWriteWith: Error | undefined;

  constructor(initial: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(initial)) this.files.set(p, c);
  }

  /** Make the next `writeFile` throw (to model I/O errors). The file is left unchanged. */
  failNextWrite(error: Error = new Error("EIO: simulated write failure")): void {
    this.failNextWriteWith = error;
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  readFile(path: string): string {
    this.ops.push({ op: "read", path });
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: no such file: ${path}`);
    return content;
  }

  writeFile(path: string, content: string): void {
    this.ops.push({ op: "write", path });
    if (this.failNextWriteWith) {
      const err = this.failNextWriteWith;
      this.failNextWriteWith = undefined;
      throw err;
    }
    this.files.set(path, content);
  }

  mkdir(path: string): void {
    this.ops.push({ op: "mkdir", path });
  }

  rename(from: string, to: string): void {
    this.ops.push({ op: "rename", path: from, to });
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`ENOENT: no such file: ${from}`);
    this.files.delete(from);
    this.files.set(to, content);
  }

  remove(path: string): void {
    this.ops.push({ op: "remove", path });
    this.files.delete(path);
  }

  /** Paths that were mutated (write, rename destination, remove), in order. */
  mutatedPaths(): string[] {
    return this.ops.filter((o) => o.op !== "read" && o.op !== "mkdir").map((o) => (o.op === "rename" ? o.to! : o.path));
  }

  writes(): FsOp[] {
    return this.ops.filter((o) => o.op === "write");
  }

  /** Mutated paths that do not start with `allowedPrefix` (e.g. the temp area). */
  writesOutside(allowedPrefix: string): string[] {
    return this.mutatedPaths().filter((p) => !p.startsWith(allowedPrefix));
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }
}
