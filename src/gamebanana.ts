// GameBanana, the second mod source: the hand-off between its pages and the
// routes they live at. Its mods use the same install pipeline as Nexus mods,
// with ids moved past GB_ID_BASE (see api.ts and py_modules/gamebanana.py).
import { SupportedGame } from "./games";
import { pushOurPage } from "./Tabs";

export const GB_BROWSE_ROUTE = "/nexus-mods/gamebanana";
export const GB_MOD_ROUTE = "/nexus-mods/gamebanana/mod";
let gbGame: SupportedGame | undefined;
let gbModId: number | undefined;

export function getGbGame(): SupportedGame | undefined {
  return gbGame;
}

export function getGbModId(): number | undefined {
  return gbModId;
}

/** Open the GameBanana store for a game. */
export function openGameBanana(game: SupportedGame): void {
  gbGame = game;
  pushOurPage(GB_BROWSE_ROUTE);
}

/** Open a GameBanana mod's page (GameBanana's own id). */
export function openGameBananaMod(game: SupportedGame, gbId: number): void {
  gbGame = game;
  gbModId = gbId;
  pushOurPage(GB_MOD_ROUTE);
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} KB`;
  return `${n} B`;
}

export function fmtDate(ts: number): string {
  return ts ? new Date(ts * 1000).toLocaleDateString() : "";
}
