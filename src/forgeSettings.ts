// Forge's switches, kept in the Steam UI's localStorage: they only change
// what the frontend does in Steam, so the backend never needs them. All on
// by default.

const KEYS = {
  gamePage: "forge.gamePageSection",
  tileDots: "forge.tileDots",
  moddedCollection: "forge.moddedCollection",
} as const;

export type ForgeSetting = keyof typeof KEYS;

const listeners = new Set<() => void>();

export function getForgeSetting(name: ForgeSetting): boolean {
  try {
    return localStorage.getItem(KEYS[name]) !== "off";
  } catch {
    return true;
  }
}

export function setForgeSetting(name: ForgeSetting, on: boolean): void {
  try {
    localStorage.setItem(KEYS[name], on ? "on" : "off");
  } catch {
    /* storage unavailable: the switch just does not persist */
  }
  for (const l of listeners) l();
}

export function subscribeForgeSettings(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
