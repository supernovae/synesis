import type { ValidationFamily } from "../validation/types.js";

export type ErrorFamilyClassifier = (message: string, ruleId?: string) => string | undefined;

export interface FastPathPatternDef {
  name: string;
  regex: RegExp;
  scope_tags: string[];
  constraint_kind: "hard" | "guiding";
  queryTransform?: (match: RegExpMatchArray, text: string) => string;
}

export interface VerificationCommand {
  tool: string;
  command: string;
  description: string;
}

export interface FixRecipe {
  errorFamily: string;
  template: string;
  description: string;
}

export interface LanguagePackManifest {
  id: string;
  language: string;
  displayName: string;
  version: string;
  families: ValidationFamily[];
  toolSignals: ToolSignal[];
  classifiers: Partial<Record<ValidationFamily, ErrorFamilyClassifier>>;
  reducerFamilies: string[];
  fastPathPatterns: FastPathPatternDef[];
  verificationCommands: VerificationCommand[];
  fixRecipes: FixRecipe[];
  corpusPackId: string;
}

export interface ToolSignal {
  pattern: RegExp;
  family: ValidationFamily;
}

export interface ConformanceEntry {
  language: string;
  displayName: string;
  version: string;
  familyCount: number;
  classifierCount: number;
  reducerCount: number;
  fastPathPatternCount: number;
  verificationCommandCount: number;
  fixRecipeCount: number;
  classifierCoverage: number;
  reducerCoverage: number;
}
