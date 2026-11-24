import { describe, expect, it } from "vitest";
import { annotate, formatMoveLine } from "./annotator.js";

describe("annotate", () => {
  it("uses 15% and 5% thresholds inclusively", () => {
    expect(annotate(15, 100)).toBe("!!");
    expect(annotate(14.99, 100)).toBe("!");
    expect(annotate(5, 100)).toBe("!");
    expect(annotate(4.99, 100)).toBe("?!");
    expect(annotate(0, 100)).toBe("?!");
    expect(annotate(-3, 100)).toBe("?!");
  });

  it("returns ?! when range is 0", () => {
    expect(annotate(10, 0)).toBe("?!");
  });
});

describe("formatMoveLine", () => {
  it("formats <n>. <name> <annotation>", () => {
    expect(formatMoveLine(1, "Guard clause", "!")).toBe("1. Guard clause !");
  });
});
