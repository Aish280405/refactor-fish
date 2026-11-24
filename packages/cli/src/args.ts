import { ts } from "ts-morph";

export const USAGE = "Usage: refactor-fish analyze <file.ts|file.tsx> [--depth 3|4]";
export const DEPTH_RANGE_MESSAGE = "Search depth must be an integer: 3 or 4 (accepted range: 3-4)";

export interface CliOptions {
  file: string;
  depth?: 3 | 4;
}

export type ParseArgsResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string; showUsage: boolean };

/** Minimal file-system surface used for validation, injected for testability. */
export interface FileReader {
  exists(path: string): boolean;
  readText(path: string): string;
}

export interface ParseErrorLocation {
  line: number; // 1-based
  column: number; // 1-based
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

export type ValidateArgsResult =
  | { ok: true; options: CliOptions; source: string }
  | { ok: false; error: string; showUsage: boolean };

/** Returns true iff the path ends in `.ts` or `.tsx`. */
export function hasSupportedExtension(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

/** Accepts only the exact strings "3" and "4". */
export function parseDepth(raw: string): 3 | 4 | undefined {
  if (raw === "3") return 3;
  if (raw === "4") return 4;
  return undefined;
}

/** Parses `analyze <file> [--depth N]`. Pure: does not touch the file system. */
export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const [command, ...rest] = argv;
  if (command !== "analyze") {
    return { ok: false, error: command === undefined ? "Missing command." : `Unknown command: ${command}`, showUsage: true };
  }

  let file: string | undefined;
  let depthRaw: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--depth") {
      const next = rest[i + 1];
      if (next === undefined) {
        return { ok: false, error: DEPTH_RANGE_MESSAGE, showUsage: false };
      }
      depthRaw = next;
      i++;
    } else if (arg.startsWith("--depth=")) {
      depthRaw = arg.slice("--depth=".length);
    } else if (arg.startsWith("--")) {
      return { ok: false, error: `Unknown option: ${arg}`, showUsage: true };
    } else if (file === undefined) {
      file = arg;
    } else {
      return { ok: false, error: `Unexpected argument: ${arg}`, showUsage: true };
    }
  }

  if (file === undefined || file === "") {
    return { ok: false, error: "Missing required argument: <file>.", showUsage: true };
  }

  let depth: 3 | 4 | undefined;
  if (depthRaw !== undefined) {
    depth = parseDepth(depthRaw);
    if (depth === undefined) {
      return { ok: false, error: `Invalid --depth "${depthRaw}". ${DEPTH_RANGE_MESSAGE}`, showUsage: false };
    }
  }

  return { ok: true, options: depth === undefined ? { file } : { file, depth } };
}

/** Finds the first syntax error in `source`, with 1-based line and column. */
export function findParseError(path: string, source: string): ParseErrorLocation | undefined {
  const result = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext },
  });
  const diag = (result.diagnostics ?? []).find((d) => d.category === ts.DiagnosticCategory.Error && d.start !== undefined);
  if (!diag || diag.start === undefined) return undefined;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, false);
  const { line, character } = sf.getLineAndCharacterOfPosition(diag.start);
  return { line: line + 1, column: character + 1, message: ts.flattenDiagnosticMessageText(diag.messageText, "\n") };
}

/** Validates existence, extension and syntax of the target file. */
export function validateTargetFile(path: string, fs: FileReader): ValidationResult & { source?: string } {
  if (!fs.exists(path)) {
    return { ok: false, error: `File not found: ${path}` };
  }
  if (!hasSupportedExtension(path)) {
    return { ok: false, error: `Unsupported file extension: ${path} (only .ts and .tsx files are supported)` };
  }
  let source: string;
  try {
    source = fs.readText(path);
  } catch (e) {
    return { ok: false, error: `Cannot read file: ${path} (${e instanceof Error ? e.message : String(e)})` };
  }
  const err = findParseError(path, source);
  if (err) {
    return { ok: false, error: `Parse error in ${path} at line ${err.line}, column ${err.column}: ${err.message}` };
  }
  return { ok: true, source };
}

/** Full CLI validation: arguments, then file. No Engine or Web UI is involved. */
export function validateCliArgs(argv: readonly string[], fs: FileReader): ValidateArgsResult {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return parsed;
  const file = validateTargetFile(parsed.options.file, fs);
  if (!file.ok) return { ok: false, error: file.error, showUsage: false };
  return { ok: true, options: parsed.options, source: file.source ?? "" };
}
