import { USAGE, validateCliArgs, type CliOptions, type FileReader } from "./args.js";

export interface CliIo {
  fs: FileReader;
  stderr: (line: string) => void;
}

export interface CliResult {
  exitCode: number;
  options?: CliOptions;
  source?: string;
}

/**
 * Validates arguments and target file. On any validation failure writes to stderr
 * and returns a non-zero exit code; callers start the Engine/Web UI only on exitCode 0.
 */
export function validateAndReport(argv: readonly string[], io: CliIo): CliResult {
  const result = validateCliArgs(argv, io.fs);
  if (!result.ok) {
    io.stderr(`Error: ${result.error}`);
    if (result.showUsage) io.stderr(USAGE);
    return { exitCode: 1 };
  }
  return { exitCode: 0, options: result.options, source: result.source };
}
