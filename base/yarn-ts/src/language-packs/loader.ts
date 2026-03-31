import { getLanguagePackRegistry } from "./registry.js";
import { ALL_PACKS } from "./packs/index.js";

let _loaded = false;

export function loadAllPacks(): void {
  if (_loaded) return;
  const registry = getLanguagePackRegistry();
  for (const pack of ALL_PACKS) {
    registry.register(pack);
  }
  _loaded = true;
}

export function isLoaded(): boolean {
  return _loaded;
}

export function resetLoader(): void {
  _loaded = false;
}
