import type { Annotation } from "./types.js";

/** Legal-move annotation. Blunders (`??`) are assigned upstream. */
export function annotate(
  gain: number,
  range: number,
): Exclude<Annotation, "??"> {
  if (!(range > 0)) return "?!";
  // Compare without rounding: gain/range >= p  <=>  gain*100 >= range*(p*100)
  if (gain * 100 >= range * 15) return "!!";
  if (gain * 100 >= range * 5) return "!";
  return "?!";
}

/** Formats a move as `<n>. <Move name> <Annotation>`. */
export function formatMoveLine(
  index: number,
  displayName: string,
  annotation: Annotation,
): string {
  return `${index}. ${displayName} ${annotation}`;
}
