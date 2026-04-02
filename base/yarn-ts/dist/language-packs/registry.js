export class LanguagePackRegistry {
    byLanguage = new Map();
    byFamily = new Map();
    byToolSignal = [];
    register(pack) {
        if (this.byLanguage.has(pack.language)) {
            throw new Error(`Language pack already registered for "${pack.language}"`);
        }
        this.byLanguage.set(pack.language, pack);
        for (const family of pack.families) {
            if (this.byFamily.has(family)) {
                throw new Error(`Family "${family}" already claimed by pack "${this.byFamily.get(family).id}", cannot register in "${pack.id}"`);
            }
            this.byFamily.set(family, pack);
        }
        for (const sig of pack.toolSignals) {
            this.byToolSignal.push({ pattern: sig.pattern, pack });
        }
    }
    getByLanguage(language) {
        return this.byLanguage.get(language);
    }
    getByFamily(family) {
        return this.byFamily.get(family);
    }
    detectFamilyFromTool(toolName, rawOutput) {
        const combined = `${toolName} ${rawOutput}`.toLowerCase();
        for (const { pattern, pack } of this.byToolSignal) {
            if (pattern.test(combined)) {
                return pack.families[0];
            }
        }
        return undefined;
    }
    getAllPacks() {
        return Array.from(this.byLanguage.values());
    }
    getConformanceMatrix() {
        return this.getAllPacks().map((pack) => {
            const familyCount = pack.families.length;
            const classifierCount = Object.keys(pack.classifiers).length;
            const reducerCount = pack.reducerFamilies.length;
            return {
                language: pack.language,
                displayName: pack.displayName,
                version: pack.version,
                familyCount,
                classifierCount,
                reducerCount,
                fastPathPatternCount: pack.fastPathPatterns.length,
                verificationCommandCount: pack.verificationCommands.length,
                fixRecipeCount: pack.fixRecipes.length,
                classifierCoverage: familyCount > 0 ? classifierCount / familyCount : 0,
                reducerCoverage: familyCount > 0 ? reducerCount / familyCount : 0,
            };
        });
    }
    get size() {
        return this.byLanguage.size;
    }
}
let _instance;
export function getLanguagePackRegistry() {
    if (!_instance) {
        _instance = new LanguagePackRegistry();
    }
    return _instance;
}
export function resetLanguagePackRegistry() {
    _instance = undefined;
}
