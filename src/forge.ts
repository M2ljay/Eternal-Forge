// Forge's background half: tells the backend which games it manages, keeps
// the tile-dot stylesheet in Steam's main window, and feeds game starts and
// exits to the crash guard.
import { Navigation, findSP } from "@decky/ui";
import { toaster } from "@decky/api";

import { forgeGuardExit, forgeGuardLaunch, forgeRegisterGames, forgeUpdateDots, getInstalledMods } from "./api";
import { DOT_STYLE_ID, appsWithUpdates, dotCss, modSet, offerToast } from "./forgeRules";
import { getForgeSetting, subscribeForgeSettings } from "./forgeSettings";
import { getSupportedGame, managedGames, modeParams } from "./games";
import { subscribeGameState } from "./state";

/** Domain, app id and folder of every managed game, for the backend's
 * anti-cheat gate on calls that name only a domain. */
export function registerManagedGames(): void {
  const games = managedGames().map(
    (g) => [g.nexusDomain, g.appId, g.installDirName] as [string, number, string]
  );
  forgeRegisterGames(games).catch(() => undefined);
}

// ---- Tile dots ---------------------------------------------------------------

let lastCss = "";

function styleDoc(): Document | undefined {
  try {
    return findSP()?.document ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStyle(css: string): void {
  const doc = styleDoc();
  if (!doc) return;
  try {
    let el = doc.getElementById(DOT_STYLE_ID) as HTMLStyleElement | null;
    if (!css) {
      el?.remove();
      return;
    }
    if (!el) {
      el = doc.createElement("style");
      el.id = DOT_STYLE_ID;
      doc.head.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  } catch (e) {
    console.error("Forge: tile dots not drawn", e);
  }
}

async function refreshDots(askNexus: boolean): Promise<void> {
  const games = managedGames();
  const domains = [...new Set(games.map((g) => g.nexusDomain))];
  if (domains.length === 0) return;
  const r = await forgeUpdateDots(domains, askNexus);
  if (!r?.ok) return;
  lastCss = dotCss(appsWithUpdates(games, r.games ?? {}));
  writeStyle(getForgeSetting("tileDots") ? lastCss : "");
}

// The backend decides what actually reaches Nexus (six-hour cache, three
// games per call, calls 20 s apart); this only says how often to ask.
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 30 * 60_000;

export function startForgeBackground(): () => void {
  const first = setTimeout(() => void refreshDots(true).catch(() => undefined), FIRST_CHECK_MS);
  const every = setInterval(() => void refreshDots(true).catch(() => undefined), CHECK_EVERY_MS);
  // A mod installed, updated or switched: recount from the cache, no network.
  const unsubState = subscribeGameState(() => void refreshDots(false).catch(() => undefined));
  const unsubSettings = subscribeForgeSettings(() =>
    writeStyle(getForgeSetting("tileDots") ? lastCss : "")
  );
  return () => {
    clearTimeout(first);
    clearInterval(every);
    unsubState();
    unsubSettings();
    writeStyle("");
  };
}

// ---- Crash guard ------------------------------------------------------------

export function guardGameStarted(appId: number): void {
  const game = getSupportedGame(appId);
  if (!game) return;
  getInstalledMods(
    game.nexusDomain,
    game.installDirName,
    game.modsSubdir,
    ...modeParams(game),
    game.protectedModFolders ?? []
  )
    .then((r) => (r.ok ? forgeGuardLaunch(appId, game.nexusDomain, modSet(r.mods ?? [])) : undefined))
    .catch(() => undefined);
}

export function guardGameStopped(appId: number): void {
  const game = getSupportedGame(appId);
  if (!game) return;
  forgeGuardExit(appId, game.processName ?? "", game.installDirName)
    .then((r) => {
      if (!r?.notify) return;
      toaster.toast({
        ...offerToast(game.displayName),
        duration: 15000,
        onClick: () => Navigation.Navigate(`/library/app/${appId}`),
      });
    })
    .catch(() => undefined);
}
