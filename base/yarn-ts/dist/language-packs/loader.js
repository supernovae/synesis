import { getLanguagePackRegistry } from "./registry.js";
import { ALL_PACKS } from "./packs/index.js";
let _loaded = false;
export function loadAllPacks() {
    if (_loaded)
        return;
    const registry = getLanguagePackRegistry();
    for (const pack of ALL_PACKS) {
        registry.register(pack);
    }
    _loaded = true;
}
export function isLoaded() {
    return _loaded;
}
export function resetLoader() {
    _loaded = false;
}
