// Forge: OptiScaler's run watch. For the games that have OptiScaler in (any
// game, managed or not), the start and exit of every run go to the backend,
// which marks OptiScaler suspect when the first runs after it went in end
// in a crash report or within a minute. The first such run makes one toast
// that opens the game page, where removal is one press.
import { Navigation } from "@decky/ui";
import { toaster } from "@decky/api";

import { forgeOptiScalerExit, forgeOptiScalerInstalled, forgeOptiScalerLaunch } from "./api";

const withOpti = new Set<number>();
const listeners = new Set<(appId: number) => void>();

export function loadOptiScalerGames(): void {
  forgeOptiScalerInstalled()
    .then((r) => {
      if (!r?.ok) return;
      withOpti.clear();
      for (const id of r.app_ids ?? []) withOpti.add(id);
    })
    .catch(() => undefined);
}

export function noteOptiScaler(appId: number, installed: boolean): void {
  if (installed) withOpti.add(appId);
  else withOpti.delete(appId);
}

/** The game page entry re-reads its status when this fires for its game. */
export function subscribeOptiScaler(fn: (appId: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function optiscalerGameEvent(appId: number, running: boolean, gameName?: string): void {
  if (!withOpti.has(appId)) return;
  if (running) {
    forgeOptiScalerLaunch(appId).catch(() => undefined);
    return;
  }
  forgeOptiScalerExit(appId)
    .then((r) => {
      if (!r?.event) return;
      for (const fn of listeners) fn(appId);
      if (!r.notify) return;
      toaster.toast({
        title: "OptiScaler: the game closed early",
        body: `${gameName ?? "The game"} stopped soon after OptiScaler was added. Remove it from the game page.`,
        duration: 15000,
        onClick: () => Navigation.Navigate(`/library/app/${appId}`),
      });
    })
    .catch(() => undefined);
}
