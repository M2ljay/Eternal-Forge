// Hold Steam updates for modded games: games with mods are set to "only
// update this game when I launch it", so an update can't break mods
// overnight. Each game's previous setting is remembered by the backend
// and put back when the hold is turned off or the game's mods are gone.
import { getUpdateHold, noteUpdateHold, releaseUpdateHold } from "./api";
import { managedGames } from "./games";

/** Steam's EAppAutoUpdateBehavior. */
const ALWAYS = 0;
const ON_LAUNCH = 1;

function apps(): any {
  return (globalThis as any).SteamClient?.Apps;
}

/** A game's current auto-update setting, or undefined if Steam won't say. */
async function autoUpdateValue(appId: number): Promise<number | undefined> {
  const cached = (globalThis as any).appDetailsStore?.GetAppDetails?.(appId)?.eAutoUpdateValue;
  if (typeof cached === "number") return cached;
  return await new Promise((resolve) => {
    let done = false;
    let handle: any;
    const finish = (v: number | undefined) => {
      if (done) return;
      done = true;
      try {
        handle?.unregister?.();
      } catch {
        // already gone
      }
      resolve(v);
    };
    try {
      handle = apps()?.RegisterForAppDetails?.(appId, (d: any) =>
        finish(typeof d?.eAutoUpdateValue === "number" ? d.eAutoUpdateValue : undefined)
      );
    } catch {
      finish(undefined);
    }
    setTimeout(() => finish(undefined), 4000);
  });
}

function setValue(appId: number, value: number): boolean {
  try {
    const a = apps();
    if (!a?.SetAppAutoUpdateBehavior) return false;
    a.SetAppAutoUpdateBehavior(appId, value);
    return true;
  } catch {
    return false;
  }
}

/** Bring every game's update setting in line with the hold. Returns how
 * many games changed. */
export async function applyUpdateHold(): Promise<number> {
  const st = await getUpdateHold().catch(() => undefined);
  if (!st?.ok) return 0;
  const modded = new Set(st.domains);
  const wanted = new Set<number>();
  if (st.enabled) {
    for (const g of managedGames()) {
      if (g.appId > 0 && modded.has(g.nexusDomain)) wanted.add(g.appId);
    }
  }
  let changed = 0;
  for (const appId of wanted) {
    if (String(appId) in st.held) continue;
    const cur = await autoUpdateValue(appId);
    // Only "always keep updated" is changed: a game someone set to high
    // priority, or already to on-launch, keeps their choice.
    if (cur === ALWAYS && setValue(appId, ON_LAUNCH)) {
      await noteUpdateHold(appId, ALWAYS);
      changed++;
    }
  }
  for (const [id, prev] of Object.entries(st.held)) {
    const appId = Number(id);
    if (wanted.has(appId)) continue;
    const cur = await autoUpdateValue(appId);
    if (cur === undefined || cur === ON_LAUNCH) setValue(appId, prev);
    await releaseUpdateHold(appId);
    changed++;
  }
  return changed;
}
