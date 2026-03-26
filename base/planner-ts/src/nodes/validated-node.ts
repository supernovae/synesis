import { annotateViolations, type ValidationResult } from "./contract-validator.js";
import type { GraphState } from "../state/types.js";

type ValidatorFn = (state: GraphState) => ValidationResult;
type NodeFn = (state: GraphState) => Promise<GraphState> | GraphState;

interface ValidatedNodeOptions {
  onPreViolations?: (state: GraphState, violations: string[]) => GraphState;
  onPostViolations?: (result: GraphState, violations: string[]) => GraphState;
}

function withWarnings(state: GraphState, violations: string[]): GraphState {
  return {
    ...state,
    _validation_warnings: [...(state._validation_warnings ?? []), ...violations]
  };
}

function withAnnotatedViolations(result: GraphState, violations: string[]): GraphState {
  const annotated = annotateViolations(result, violations);
  return {
    ...result,
    critique_register: annotated.critique_register
  };
}

export function validatedNode(
  nodeFn: NodeFn,
  validatorsBefore: ValidatorFn[] = [],
  validatorsAfter: ValidatorFn[] = [],
  options: ValidatedNodeOptions = {}
): NodeFn {
  return async (state: GraphState): Promise<GraphState> => {
    let input = state;
    for (const validator of validatorsBefore) {
      const { passed, violations } = validator(input);
      if (!passed && violations.length > 0) {
        input = options.onPreViolations ? options.onPreViolations(input, violations) : withWarnings(input, violations);
      }
    }

    let result = await nodeFn(input);
    const merged = { ...input, ...result };

    for (const validator of validatorsAfter) {
      const { passed, violations } = validator(merged);
      if (!passed && violations.length > 0) {
        result = options.onPostViolations
          ? options.onPostViolations(result, violations)
          : withAnnotatedViolations(result, violations);
      }
    }

    return result;
  };
}
