// Forge's Steam collection "Modded": the games with at least one mod on
// through Forge. The reconcile itself, against anything shaped like Steam's
// collectionStore. Self-contained on purpose (no imports) so
// tests/moddedCollection.test.mjs compiles this one file and checks it under
// node with a fake store.
//
// Ownership: Forge touches exactly one collection, the one whose id it
// recorded when it created it. A collection the user made is never changed
// or deleted, even when it is called "Modded", and inside Forge's own
// collection only games Forge put there are ever taken out.

export const MODDED_NAME = "Modded";
export const FALLBACK_NAME = "Modded (Forge)";
/** The backend's MODDED_UNKNOWN: a count that could not be read. */
export const COUNT_UNKNOWN = -1;
/** Quiet time after the last mod change before the collection is touched:
 * a collection install switches hundreds of mods in a row. */
export const RECONCILE_DEBOUNCE_MS = 2000;

export interface OwnedCollection {
  /** Steam's id for the collection Forge created. */
  id: string;
  /** The name Forge gave it (or its current name, if the user renamed it). */
  name: string;
  /** Games Forge itself put in it. The only ones it may take out. */
  added: number[];
  /** The name that was already taken by someone else's collection. */
  clash?: string;
}

export interface OverviewLike {
  appid: number;
}

export interface CollectionLike {
  id: string;
  displayName: string;
  apps: { has(appId: number): boolean };
  AsDragDropCollection(): {
    AddApps(overviews: OverviewLike[]): void;
    RemoveApps(overviews: OverviewLike[]): void;
  };
  Save(): Promise<void>;
  Delete(): Promise<void>;
}

export interface CollectionStoreLike {
  userCollections: CollectionLike[];
  GetUserCollectionsByName?(name: string): CollectionLike[];
  NewUnsavedCollection(name: string, filter?: unknown, overviews?: OverviewLike[]): CollectionLike;
}

export interface ModLike {
  enabled: boolean;
  tracked?: boolean;
}

/** Mods on through Forge: switched on, and installed by the plugin (a
 * folder it found but did not install is not Forge's). Mods without a
 * switch (loose files) count: they are in the game. */
export function enabledThroughForge(mods: ModLike[] | undefined): number {
  return (mods ?? []).filter((m) => Boolean(m.enabled) && m.tracked !== false).length;
}

/** Forge's own collection, found by its recorded id among the user
 * collections and nothing else (never by name). */
export function findOwned(
  store: CollectionStoreLike,
  record: OwnedCollection | null | undefined
): CollectionLike | undefined {
  if (!record?.id) return undefined;
  return store.userCollections.find((c) => c.id === record.id);
}

/** Steam's collection names are case-insensitive: "modded" is "Modded". */
export function nameTaken(store: CollectionStoreLike, name: string): boolean {
  const low = name.toLowerCase();
  if (store.userCollections.some((c) => (c.displayName ?? "").toLowerCase() === low)) return true;
  try {
    return (store.GetUserCollectionsByName?.(name) ?? []).length > 0;
  } catch {
    return false;
  }
}

/** "Modded" when it is free, else "Modded (Forge)", else "Modded (Forge 2)"
 * and so on. clash names the taken "Modded" so Settings can say why. */
export function pickName(store: CollectionStoreLike): { name: string; clash?: string } {
  if (!nameTaken(store, MODDED_NAME)) return { name: MODDED_NAME };
  if (!nameTaken(store, FALLBACK_NAME)) return { name: FALLBACK_NAME, clash: MODDED_NAME };
  for (let n = 2; n < 100; n++) {
    const name = `Modded (Forge ${n})`;
    if (!nameTaken(store, name)) return { name, clash: MODDED_NAME };
  }
  return { name: `Modded (Forge ${Date.now()})`, clash: MODDED_NAME };
}

export interface ReconcileResult {
  /** What to record now; null when Forge has no collection. */
  record: OwnedCollection | null;
  /** The record differs from the one passed in and should be saved. */
  changed: boolean;
  created: boolean;
  added: number[];
  removed: number[];
}

function sameRecord(a: OwnedCollection | null, b: OwnedCollection | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.id === b.id &&
    a.name === b.name &&
    (a.clash ?? "") === (b.clash ?? "") &&
    a.added.length === b.added.length &&
    a.added.every((x, i) => x === b.added[i])
  );
}

/** Put Forge's collection in step with `modded`.
 *
 * - No collection yet and nothing modded: nothing is created.
 * - No collection yet (or the recorded one was deleted) and a game is
 *   modded: a new one is created, under a free name, and recorded.
 * - Otherwise games that are modded and missing are added, and games Forge
 *   added that are no longer modded are taken out. Games someone else put
 *   in are never taken out. Once made, the collection stays even when empty.
 *
 * `overview` returns Steam's overview of an app, or null for an app Steam
 * does not know (it is not added). */
export async function reconcileModdedCollection(
  store: CollectionStoreLike,
  record: OwnedCollection | null | undefined,
  modded: number[],
  overview: (appId: number) => OverviewLike | null
): Promise<ReconcileResult> {
  const prev = record?.id ? record : null;
  const want = new Set(modded.filter((a) => Number.isInteger(a) && a > 0));
  const owned = findOwned(store, prev);

  if (!owned) {
    const overviews = [...want]
      .sort((a, b) => a - b)
      .map((a) => overview(a))
      .filter((o): o is OverviewLike => Boolean(o));
    if (overviews.length === 0) {
      // The recorded collection is gone (deleted in Steam): forget it, and
      // make a new one only once there is something to put in it.
      return { record: null, changed: prev !== null, created: false, added: [], removed: [] };
    }
    const { name, clash } = pickName(store);
    const created = store.NewUnsavedCollection(name, undefined, []);
    created.AsDragDropCollection().AddApps(overviews);
    await created.Save();
    const id =
      created.id ||
      store.userCollections.find((c) => (c.displayName ?? "").toLowerCase() === name.toLowerCase())?.id ||
      "";
    const ids = overviews.map((o) => o.appid);
    const next: OwnedCollection | null = id
      ? { id, name, added: ids, ...(clash ? { clash } : {}) }
      : null;
    return { record: next, changed: !sameRecord(prev, next), created: true, added: ids, removed: [] };
  }

  const ours = new Set(prev!.added);
  const toAdd: OverviewLike[] = [];
  for (const a of [...want].sort((x, y) => x - y)) {
    if (owned.apps.has(a)) continue;
    const o = overview(a);
    if (o) toAdd.push(o);
  }
  const toRemove = [...ours].filter((a) => !want.has(a) && owned.apps.has(a)).sort((x, y) => x - y);

  if (toAdd.length || toRemove.length) {
    const dd = owned.AsDragDropCollection();
    if (toRemove.length) dd.RemoveApps(toRemove.map((a) => overview(a) ?? { appid: a }));
    if (toAdd.length) dd.AddApps(toAdd);
    await owned.Save();
  }

  // Still ours: what Forge added that is still in it and still modded,
  // plus what it just added. A game the user took out by hand is no
  // longer recorded (and comes back while it is modded).
  const removed = new Set(toRemove);
  const keep = [...ours].filter((a) => !removed.has(a) && owned.apps.has(a));
  const addedNow = toAdd.map((o) => o.appid);
  const nextAdded = [...new Set([...keep, ...addedNow])].sort((x, y) => x - y);
  const next: OwnedCollection = {
    id: owned.id,
    name: owned.displayName || prev!.name,
    added: nextAdded,
    ...(prev!.clash ? { clash: prev!.clash } : {}),
  };
  return { record: next, changed: !sameRecord(prev, next), created: false, added: addedNow, removed: toRemove };
}

/** "Remove Modded collection": deletes Forge's own collection, found by
 * its recorded id, and nothing else. True when one was deleted. */
export async function removeOwnedCollection(
  store: CollectionStoreLike,
  record: OwnedCollection | null | undefined
): Promise<boolean> {
  const owned = findOwned(store, record);
  if (!owned) return false;
  await owned.Delete();
  return true;
}

/** What Settings says about Forge's collection. */
export function collectionNote(record: OwnedCollection | null | undefined): string {
  if (!record?.id) return "Forge has not made a collection yet: it does once a game has a mod on.";
  const base = `Forge's collection is "${record.name || MODDED_NAME}"`;
  return record.clash
    ? `${base}: a collection called "${record.clash}" already existed and is yours, so Forge left it alone.`
    : `${base}.`;
}

// ---- Scheduling ----------------------------------------------------------------

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Collects the games that changed and runs `fn` once things go quiet.
 * A domain of "" (a call that did not say which game) or `full` asks for
 * every game to be recounted. Runs never overlap: a request that arrives
 * during a run is held and runs after it. */
export class ModdedScheduler {
  private handle: unknown = undefined;
  private domains = new Set<string>();
  private full = false;
  private running = false;
  private again = false;

  constructor(
    private readonly fn: (job: { full: boolean; domains: string[] }) => Promise<void>,
    private readonly timers: Timers,
    private readonly delay: number = RECONCILE_DEBOUNCE_MS
  ) {}

  request(domain: string | null): void {
    if (domain === null || domain === "") this.full = true;
    else this.domains.add(domain);
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = this.timers.set(() => {
      this.handle = undefined;
      void this.flush();
    }, this.delay);
  }

  get pending(): boolean {
    return this.handle !== undefined || this.running;
  }

  cancel(): void {
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = undefined;
    this.domains.clear();
    this.full = false;
    this.again = false;
  }

  private async flush(): Promise<void> {
    if (!this.full && this.domains.size === 0) return;
    const job = { full: this.full, domains: [...this.domains].sort() };
    this.full = false;
    this.domains.clear();
    this.running = true;
    try {
      await this.fn(job);
    } catch {
      /* the next change tries again */
    } finally {
      this.running = false;
    }
    if (this.again) {
      this.again = false;
      this.handle = this.timers.set(() => {
        this.handle = undefined;
        void this.flush();
      }, this.delay);
    }
  }
}
