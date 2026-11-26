// Forge's Steam collection "Modded", wired to Steam and the backend. The
// rules (ownership, names, what goes in and out) are in moddedCollection.ts;
// this counts mods from disk, keeps the backend's record and drives Steam's
// collectionStore. Fully offline: get_installed_mods reads the game folder,
// and nothing here reaches Nexus.
import { addEventListener, removeEventListener } from "@decky/api";

import {
  ForgeModdedCollectionRecord,
  forgeModdedState,
  forgeNoteModded,
  forgeSetModdedCollection,
  getInstalledMods,
} from "./api";
import { getForgeSetting, setForgeSetting, subscribeForgeSettings } from "./forgeSettings";
import { SupportedGame, managedGames, modeParams } from "./games";
import {
  COUNT_UNKNOWN,
  CollectionStoreLike,
  ModdedScheduler,
  OverviewLike,
  OwnedCollection,
  enabledThroughForge,
  reconcileModdedCollection,
  removeOwnedCollection,
} from "./moddedCollection";

/** First reconcile after the plugin loads: late enough that Steam has its
 * collections (a "Modded" of the user's that is not loaded yet must not
 * look like a free name). */
const FIRST_RECONCILE_MS = 20_000;
const STEAM_RETRY_MS = 15_000;
const STEAM_RETRIES = 8;

function steamCollections(): CollectionStoreLike | undefined {
  const s = (globalThis as any).collectionStore;
  if (!s || !s.userCollections || typeof s.NewUnsavedCollection !== "function") return undefined;
  return s as CollectionStoreLike;
}

function overviewOf(appId: number): OverviewLike | null {
  try {
    return (globalThis as any).appStore?.GetAppOverviewByAppID?.(appId) ?? null;
  } catch {
    return null;
  }
}

function toOwned(rec: ForgeModdedCollectionRecord | undefined): OwnedCollection | null {
  if (!rec?.id) return null;
  return { id: rec.id, name: rec.name ?? "", added: rec.added ?? [], ...(rec.clash ? { clash: rec.clash } : {}) };
}

async function countFor(game: SupportedGame): Promise<number> {
  try {
    const r = await getInstalledMods(
      game.nexusDomain,
      game.installDirName,
      game.modsSubdir,
      ...modeParams(game),
      game.protectedModFolders ?? []
    );
    return r.ok ? enabledThroughForge(r.mods) : COUNT_UNKNOWN;
  } catch {
    return COUNT_UNKNOWN;
  }
}

// One thing at a time against Steam's store: a reconcile and the Settings
// button never interleave.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

let steamRetries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let scheduler: ModdedScheduler | undefined;

async function runJob(job: { full: boolean; domains: string[] }): Promise<void> {
  const st = await forgeModdedState();
  if (!st?.ok) return;
  const games = managedGames().filter((g) => g.appId > 0);
  const withRecords = new Set(st.domains);
  const entries: [number, string, number][] = [];
  if (job.full) {
    for (const g of games) {
      // A game with no install records has nothing on: no need to scan it.
      entries.push([g.appId, g.nexusDomain, withRecords.has(g.nexusDomain) ? await countFor(g) : 0]);
    }
  } else {
    const changed = new Set(job.domains);
    for (const g of games.filter((g) => changed.has(g.nexusDomain))) {
      entries.push([g.appId, g.nexusDomain, await countFor(g)]);
    }
  }
  let modded = st.modded;
  if (entries.length || job.full) {
    const noted = await forgeNoteModded(entries, job.full);
    if (noted?.ok) modded = noted.modded;
  }
  if (!getForgeSetting("moddedCollection")) return;
  await serial(async () => {
    const store = steamCollections();
    if (!store) {
      // Steam's store is not up yet: try again a little later, a few times.
      if (steamRetries < STEAM_RETRIES && retryTimer === undefined) {
        steamRetries += 1;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          scheduler?.request(null);
        }, STEAM_RETRY_MS);
      }
      return;
    }
    steamRetries = 0;
    // Read the record again inside the queue: the Settings button may have
    // just forgotten it.
    const fresh = await forgeModdedState();
    if (!fresh?.ok || !getForgeSetting("moddedCollection")) return;
    const r = await reconcileModdedCollection(store, toOwned(fresh.collection), modded, overviewOf);
    if (r.created) console.log(`Forge: created the Steam collection "${r.record?.name}"`);
    if (r.added.length || r.removed.length) {
      console.log(`Forge: Modded collection +${r.added.length} -${r.removed.length}`);
    }
    if (r.changed) await forgeSetModdedCollection(r.record ?? {});
  });
}

/** Start keeping the collection: a full recount shortly after load, then
 * one per game after every mod change the backend announces. */
export function startModdedCollection(): () => void {
  const timers = {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const sched = new ModdedScheduler(runJob, timers);
  scheduler = sched;
  const first = setTimeout(() => sched.request(null), FIRST_RECONCILE_MS);
  const listener = addEventListener<[domain: string, appId: number]>("forge_mods_changed", (domain) =>
    sched.request(typeof domain === "string" ? domain : "")
  );
  let wasOn = getForgeSetting("moddedCollection");
  const unsubSettings = subscribeForgeSettings(() => {
    const on = getForgeSetting("moddedCollection");
    if (on && !wasOn) sched.request(null);
    wasOn = on;
  });
  return () => {
    clearTimeout(first);
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    sched.cancel();
    if (scheduler === sched) scheduler = undefined;
    removeEventListener("forge_mods_changed", listener);
    unsubSettings();
  };
}

/** The record of Forge's own collection, for Settings. */
export async function moddedCollectionRecord(): Promise<OwnedCollection | null> {
  const st = await forgeModdedState().catch(() => undefined);
  return st?.ok ? toOwned(st.collection) : null;
}

/** "Remove Modded collection": stop keeping it (or it would come back at
 * the next mod change), then delete Forge's own collection - found by its
 * recorded id, never by name - and forget it. */
export async function removeModdedCollection(): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  setForgeSetting("moddedCollection", false);
  return serial(async () => {
    const store = steamCollections();
    if (!store) return { ok: false, removed: false, error: "Steam's collections are not available right now." };
    const st = await forgeModdedState();
    if (!st?.ok) return { ok: false, removed: false, error: "Could not read Forge's record." };
    const removed = await removeOwnedCollection(store, toOwned(st.collection));
    await forgeSetModdedCollection({});
    return { ok: true, removed };
  });
}
