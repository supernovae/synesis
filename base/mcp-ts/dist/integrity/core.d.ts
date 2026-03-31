/**
 * Reusable code integrity checks — TypeScript port of integrity_core.py.
 * Pure functions; no framework dependency.
 */
export declare class IntegrityResult {
    category: string;
    evidence: string;
    remediation: string;
    constructor(category?: string, evidence?: string, remediation?: string);
}
export declare class IntegrityReport {
    passed: boolean;
    failures: IntegrityResult[];
    add(failure: IntegrityResult | null | undefined): void;
}
export declare function checkSecrets(code: string): IntegrityResult | null;
export declare function checkNetwork(code: string, language: string): IntegrityResult | null;
export declare function checkDangerousCommands(code: string, language: string): IntegrityResult | null;
export declare function checkMaxSize(code: string, limit?: number): IntegrityResult | null;
export declare function checkPathDenylist(code: string, denylist?: readonly string[]): IntegrityResult | null;
export interface PatchOpInput {
    path?: string;
    op?: string;
    text?: string;
    content?: string;
}
export declare function checkPatchOpConstraints(patchOps: PatchOpInput[]): IntegrityResult | null;
export declare function checkWorkspaceBoundary(filesTouched: string[], patchOps: PatchOpInput[], targetWorkspace: string): IntegrityResult | null;
export declare function checkImportIntegrity(_code: string, _language: string, _trustedPackages?: Set<string> | null): IntegrityResult | null;
export declare function checkPythonSyntax(_code: string, _language: string): IntegrityResult | null;
export declare function checkUtf8(code: string): IntegrityResult | null;
export declare function checkExperimentCommands(commands: string[]): IntegrityResult | null;
export declare function runAllChecks(code: string, language?: string, patchOps?: PatchOpInput[] | null, filesTouched?: string[] | null, targetWorkspace?: string, commands?: string[] | null, trustedPackages?: Set<string> | null, maxCodeChars?: number): IntegrityReport;
