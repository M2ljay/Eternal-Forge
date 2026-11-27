// Which game Forge's Load order panel is open for. Set by the game page just
// before it pushes the panel's route (pushFromGamePage), read by the panel at
// mount. A module value rather than a URL parameter because the route is
// registered once with routerHook and our pages take their context the same
// way (state.ts: the browsed game, the selected mod).
import type { SupportedGame } from "./games";

export const FORGE_LOAD_ORDER_ROUTE = "/nexus-mods/forge-load-order";

export interface ForgeLoScope {
  appId: number;
  /** Nexus domain when Forge manages the game, else "". */
  domain: string;
  installDir: string;
  /** The game's name as Steam shows it. */
  name: string;
  /** The managed game, when there is one: profiles switch its mods. */
  game?: SupportedGame;
}

let scope: ForgeLoScope | undefined;

export function setForgeLoadOrderScope(s: ForgeLoScope): void {
  scope = s;
}

export function getForgeLoadOrderScope(): ForgeLoScope | undefined {
  return scope;
}
