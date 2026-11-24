import { Project, ScriptTarget, ts } from "ts-morph";
import type { SourceFile, TypeChecker } from "ts-morph";
import type { ApplyResult, Position } from "./types.js";

export interface EditableUnit {
  getSourceFile(): SourceFile;
  getTypeChecker(): TypeChecker;
  /** Returns the current source text; never mutates the originating Position. */
  commit(): string;
}

function createProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { target: ScriptTarget.ES2022, strict: true },
  });
}

function virtualPath(position: Position): string {
  const p = position.filePath || "target.ts";
  return p.startsWith("/") ? p : `/${p}`;
}

/** Fresh in-memory project per call, so Positions stay immutable values. */
export const AstEditor = {
  load(position: Position): EditableUnit {
    const project = createProject();
    const sourceFile = project.createSourceFile(
      virtualPath(position),
      position.sourceText,
      { overwrite: true },
    );
    return {
      getSourceFile: () => sourceFile,
      getTypeChecker: () => project.getTypeChecker(),
      commit: () => sourceFile.getFullText(),
    };
  },
};

/** Returns syntax error messages for `sourceText` (empty when it parses cleanly). */
export function syntaxErrors(sourceText: string, filePath = "target.ts"): string[] {
  const project = createProject();
  const path = filePath.startsWith("/") ? filePath : `/${filePath}`;
  const sf = project.createSourceFile(path, sourceText, { overwrite: true });
  const diagnostics = project.getProgram().getSyntacticDiagnostics(sf);
  return diagnostics.map((d) => {
    const text = d.getMessageText();
    const message =
      typeof text === "string" ? text : ts.flattenDiagnosticMessageText(text.compilerObject, "\n");
    const line = d.getLineNumber();
    return line === undefined ? message : `line ${line}: ${message}`;
  });
}

export function parsesCleanly(sourceText: string, filePath = "target.ts"): boolean {
  return syntaxErrors(sourceText, filePath).length === 0;
}

/**
 * Shared wrapper for every Move's apply(). Runs `edit` on a fresh unit, then
 * verifies the result re-parses. Never throws and never mutates `position`.
 */
export function safeApply(
  position: Position,
  edit: (unit: EditableUnit) => void,
): ApplyResult {
  try {
    const unit = AstEditor.load(position);
    edit(unit);
    const resultingSource = unit.commit();
    const errors = syntaxErrors(resultingSource, position.filePath);
    if (errors.length > 0) {
      return {
        ok: false,
        error: { reason: `Edit produced unparseable source: ${errors[0]}` },
      };
    }
    return { ok: true, resultingSource };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { reason: `Edit failed: ${msg}` } };
  }
}
