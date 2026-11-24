export { generateRemoveUnused } from "./remove-unused.js";
export { generateInlineVariable } from "./inline-variable.js";
export { generateGuardClauseCandidates } from "./guard-clause.js";
export { generateSimplifyBoolean } from "./simplify-boolean.js";
export { generateExtractFunctionCandidates, selectFunctionName } from "./extract-function.js";
export {
  DeterministicMoveGenerator,
  DETERMINISTIC_CATALOG,
  type SubGenerator,
} from "./deterministic-move-generator.js";
