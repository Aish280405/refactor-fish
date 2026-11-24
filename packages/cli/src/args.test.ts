import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { hasSupportedExtension, parseArgs, parseDepth, validateCliArgs, validateTargetFile, type FileReader } from "./args.js";
import { validateAndReport } from "./run.js";

const memFs = (files: Record<string, string>): FileReader => ({
  exists: (p) => p in files,
  readText: (p) => files[p],
});

describe("parseArgs", () => {
  it("parses file and depth", () => {
    expect(parseArgs(["analyze", "a.ts", "--depth", "4"])).toEqual({ ok: true, options: { file: "a.ts", depth: 4 } });
    expect(parseArgs(["analyze", "a.ts", "--depth=3"])).toEqual({ ok: true, options: { file: "a.ts", depth: 3 } });
    expect(parseArgs(["analyze", "a.ts"])).toEqual({ ok: true, options: { file: "a.ts" } });
  });

  it("rejects missing argument with usage", () => {
    const r = parseArgs(["analyze"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.showUsage).toBe(true);
  });

  it("rejects bad depths and states the range", () => {
    for (const d of ["2", "5", "3.5", "abc", "", "03", "-3"]) {
      const r = parseArgs(["analyze", "a.ts", "--depth", d]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("3 or 4");
    }
  });

  it("property: depth accepted iff exactly 3 or 4", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.string(), fc.double()), (v) => {
        const s = String(v);
        const r = parseArgs(["analyze", "a.ts", `--depth=${s}`]);
        expect(r.ok).toBe(s === "3" || s === "4");
        expect(parseDepth(s) !== undefined).toBe(s === "3" || s === "4");
      }),
    );
  });
});

describe("validateTargetFile", () => {
  it("reports missing file by path", () => {
    const r = validateTargetFile("nope.ts", memFs({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nope.ts");
  });

  it("rejects wrong extension", () => {
    const r = validateTargetFile("a.js", memFs({ "a.js": "let x = 1;" }));
    expect(r.ok).toBe(false);
  });

  it("reports parse error with path, line and column", () => {
    const r = validateTargetFile("a.ts", memFs({ "a.ts": "const a = 1;\nconst = ;\n" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/a\.ts at line 2, column \d+/);
  });

  it("accepts valid .ts and .tsx", () => {
    expect(validateTargetFile("a.ts", memFs({ "a.ts": "export const x: number = 1;" })).ok).toBe(true);
    expect(validateTargetFile("a.tsx", memFs({ "a.tsx": "export const x = <div/>;" })).ok).toBe(true);
  });

  // Feature: refactor-fish, Property 1: Extension validation
  it("property: extension accepted iff .ts or .tsx", () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom("", ".ts", ".tsx", ".js", ".d.mts", ".tsx.bak"), (stem, ext) => {
        const p = stem + ext;
        expect(hasSupportedExtension(p)).toBe(p.endsWith(".ts") || p.endsWith(".tsx"));
        if (!hasSupportedExtension(p)) {
          const r = validateTargetFile(p, memFs({ [p]: "const a = 1;" }));
          expect(r.ok).toBe(false);
        }
      }),
    );
  });

  // Feature: refactor-fish, Property 2: Parse-error location reporting
  it("property: parse errors report a real line/column", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("const a = 1;", "", "let b = 2;"), { maxLength: 5 }), fc.constantFrom("const = ;", "function (", "if ("), (lines, bad) => {
        const src = [...lines, bad].join("\n");
        const r = validateTargetFile("f.ts", memFs({ "f.ts": src }));
        expect(r.ok).toBe(false);
        if (!r.ok) {
          const m = /line (\d+), column (\d+)/.exec(r.error)!;
          const line = Number(m[1]);
          const col = Number(m[2]);
          const srcLines = src.split("\n");
          expect(line).toBeGreaterThanOrEqual(1);
          expect(line).toBeLessThanOrEqual(srcLines.length);
          expect(col).toBeGreaterThanOrEqual(1);
          expect(col).toBeLessThanOrEqual(srcLines[line - 1].length + 1);
          expect(r.error).toContain("f.ts");
        }
      }),
    );
  });
});

describe("validateAndReport", () => {
  it("writes usage to stderr and exits non-zero on missing argument", () => {
    const out: string[] = [];
    const r = validateAndReport(["analyze"], { fs: memFs({}), stderr: (l) => out.push(l) });
    expect(r.exitCode).not.toBe(0);
    expect(out.join("\n")).toContain("Usage:");
  });

  it("returns exit 0 and options for valid input", () => {
    const r = validateAndReport(["analyze", "a.ts", "--depth", "3"], { fs: memFs({ "a.ts": "const a = 1;" }), stderr: () => {} });
    expect(r.exitCode).toBe(0);
    expect(r.options).toEqual({ file: "a.ts", depth: 3 });
    expect(validateCliArgs(["analyze", "a.ts"], memFs({ "a.ts": "const a = 1;" })).ok).toBe(true);
  });
});
