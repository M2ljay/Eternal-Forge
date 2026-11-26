// Forge's Steam collection "Modded": ownership, names, what goes in and
// out, and the debounced scheduling, against a fake collectionStore.
// Run via: pnpm run test:modded (compiles src/moddedCollection.ts
// standalone, then executes this file)
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  FALLBACK_NAME,
  MODDED_NAME,
  ModdedScheduler,
  collectionNote,
  enabledThroughForge,
  findOwned,
  pickName,
  reconcileModdedCollection,
  removeOwnedCollection,
} from "../.test-build/moddedCollection.js";

// ---- fake Steam ---------------------------------------------------------------

let nextId = 1;

class FakeCollection {
  constructor(store, name, apps = []) {
    this.store = store;
    this.id = "";
    this.displayName = name;
    this.appSet = new Set(apps);
    this.saves = 0;
    this.deleted = false;
    this.apps = { has: (a) => this.appSet.has(a) };
  }
  AsDragDropCollection() {
    return {
      AddApps: (overviews) => overviews.forEach((o) => this.appSet.add(o.appid)),
      RemoveApps: (overviews) => overviews.forEach((o) => this.appSet.delete(o.appid)),
    };
  }
  async Save() {
    this.saves += 1;
    if (!this.id) {
      this.id = `uc-${nextId++}`;
      this.store.userCollections.push(this);
    }
  }
  async Delete() {
    this.deleted = true;
    this.store.userCollections = this.store.userCollections.filter((c) => c !== this);
  }
}

class FakeStore {
  constructor() {
    this.userCollections = [];
    this.created = [];
  }
  /** A collection that already exists (the user's, or Forge's from before). */
  existing(name, apps = []) {
    const c = new FakeCollection(this, name, apps);
    c.id = `uc-${nextId++}`;
    this.userCollections.push(c);
    return c;
  }
  NewUnsavedCollection(name) {
    const c = new FakeCollection(this, name);
    this.created.push(c);
    return c;
  }
}

const KNOWN = new Set([10, 20, 30, 40, 50]);
const overview = (a) => (KNOWN.has(a) ? { appid: a } : null);
const apps = (c) => [...c.appSet].sort((x, y) => x - y);

// ---- what counts as modded ------------------------------------------------------

test("a game is modded when a mod Forge installed is on", () => {
  assert.equal(enabledThroughForge([]), 0);
  assert.equal(enabledThroughForge(undefined), 0);
  assert.equal(enabledThroughForge([{ enabled: false, tracked: true }]), 0);
  // A folder Forge found but did not install is not Forge's.
  assert.equal(enabledThroughForge([{ enabled: true, tracked: false }]), 0);
  assert.equal(
    enabledThroughForge([{ enabled: true, tracked: true }, { enabled: true, togglable: false }, { enabled: false }]),
    2
  );
});

// ---- creating -----------------------------------------------------------------

test("nothing modded and no collection: nothing is created", async () => {
  const store = new FakeStore();
  const r = await reconcileModdedCollection(store, null, [], overview);
  assert.equal(store.created.length, 0);
  assert.equal(r.record, null);
  assert.equal(r.changed, false);
});

test("the first modded game creates Modded and records its id", async () => {
  const store = new FakeStore();
  const r = await reconcileModdedCollection(store, null, [20, 10], overview);
  assert.equal(r.created, true);
  assert.equal(store.created.length, 1);
  const c = store.created[0];
  assert.equal(c.displayName, MODDED_NAME);
  assert.deepEqual(apps(c), [10, 20]);
  assert.deepEqual(r.record, { id: c.id, name: MODDED_NAME, added: [10, 20] });
  assert.equal(r.changed, true);
});

test("an app Steam does not know is not added", async () => {
  const store = new FakeStore();
  const r = await reconcileModdedCollection(store, null, [10, 999], overview);
  assert.deepEqual(r.record.added, [10]);
  const none = await reconcileModdedCollection(new FakeStore(), null, [999], overview);
  assert.equal(none.created, false);
});

// ---- ownership ------------------------------------------------------------------

test("a user's own Modded is never taken over: Forge makes Modded (Forge)", async () => {
  const store = new FakeStore();
  const mine = store.existing("Modded", [50]);
  const r = await reconcileModdedCollection(store, null, [10], overview);
  assert.equal(r.record.name, FALLBACK_NAME);
  assert.equal(r.record.clash, MODDED_NAME);
  assert.notEqual(r.record.id, mine.id);
  assert.deepEqual(apps(mine), [50]);
  assert.equal(mine.saves, 0);
  assert.match(collectionNote(r.record), /already existed and is yours/);
});

test("the name clash is case-insensitive, as Steam's names are", async () => {
  const store = new FakeStore();
  store.existing("MODDED");
  store.existing("modded (forge)");
  assert.deepEqual(pickName(store), { name: "Modded (Forge 2)", clash: MODDED_NAME });
});

test("Forge's recorded Modded is used again, by id, after a restart", async () => {
  const store = new FakeStore();
  const ours = store.existing("Modded", [10]);
  const record = { id: ours.id, name: "Modded", added: [10] };
  const r = await reconcileModdedCollection(store, record, [10, 20], overview);
  assert.equal(store.created.length, 0);
  assert.deepEqual(apps(ours), [10, 20]);
  assert.deepEqual(r.record, { id: ours.id, name: "Modded", added: [10, 20] });
});

test("only the recorded id counts: another collection with the same name is left alone", async () => {
  const store = new FakeStore();
  const users = store.existing("Modded", [30]);
  const ours = store.existing("Modded (Forge)", [10]);
  const record = { id: ours.id, name: "Modded (Forge)", added: [10], clash: "Modded" };
  assert.equal(findOwned(store, record), ours);
  await reconcileModdedCollection(store, record, [], overview);
  assert.deepEqual(apps(users), [30]);
  assert.equal(users.saves, 0);
  assert.deepEqual(apps(ours), []);
});

test("a game Forge did not add is never taken out", async () => {
  const store = new FakeStore();
  const ours = store.existing("Modded", [10, 40]); // the user put 40 in by hand
  const record = { id: ours.id, name: "Modded", added: [10] };
  const r = await reconcileModdedCollection(store, record, [], overview);
  assert.deepEqual(apps(ours), [40]);
  assert.deepEqual(r.removed, [10]);
  assert.deepEqual(r.record.added, []);
});

test("a modded game already in it by hand stays the user's", async () => {
  const store = new FakeStore();
  const ours = store.existing("Modded", [40]);
  const record = { id: ours.id, name: "Modded", added: [] };
  const on = await reconcileModdedCollection(store, record, [40], overview);
  assert.deepEqual(on.record.added, []);
  assert.equal(ours.saves, 0);
  await reconcileModdedCollection(store, on.record, [], overview);
  assert.deepEqual(apps(ours), [40]);
});

test("mods switched off (crash restore, anti-cheat lock) take the game out", async () => {
  const store = new FakeStore();
  const first = await reconcileModdedCollection(store, null, [10, 20], overview);
  const off = await reconcileModdedCollection(store, first.record, [20], overview);
  assert.deepEqual(off.removed, [10]);
  assert.deepEqual(apps(store.userCollections[0]), [20]);
  assert.deepEqual(off.record.added, [20]);
});

test("the collection stays once made, even empty, and is not saved when nothing changed", async () => {
  const store = new FakeStore();
  const first = await reconcileModdedCollection(store, null, [10], overview);
  const empty = await reconcileModdedCollection(store, first.record, [], overview);
  assert.equal(store.userCollections.length, 1);
  const c = store.userCollections[0];
  const saves = c.saves;
  const again = await reconcileModdedCollection(store, empty.record, [], overview);
  assert.equal(c.saves, saves);
  assert.equal(again.changed, false);
});

test("a game the user took out by hand comes back while it is modded", async () => {
  const store = new FakeStore();
  const first = await reconcileModdedCollection(store, null, [10], overview);
  store.userCollections[0].appSet.delete(10);
  const r = await reconcileModdedCollection(store, first.record, [10], overview);
  assert.deepEqual(apps(store.userCollections[0]), [10]);
  assert.deepEqual(r.record.added, [10]);
});

test("a recorded collection the user deleted is forgotten, and a new one made only when needed", async () => {
  const store = new FakeStore();
  const first = await reconcileModdedCollection(store, null, [10], overview);
  await store.userCollections[0].Delete();
  const gone = await reconcileModdedCollection(store, first.record, [], overview);
  assert.equal(gone.record, null);
  assert.equal(gone.changed, true);
  const back = await reconcileModdedCollection(store, first.record, [10], overview);
  assert.equal(back.created, true);
  assert.notEqual(back.record.id, first.record.id);
});

test("a renamed Forge collection is still Forge's, under its new name", async () => {
  const store = new FakeStore();
  const first = await reconcileModdedCollection(store, null, [10], overview);
  store.userCollections[0].displayName = "My mods";
  const r = await reconcileModdedCollection(store, first.record, [10, 20], overview);
  assert.equal(r.record.name, "My mods");
  assert.equal(store.created.length, 1);
});

// ---- removing -----------------------------------------------------------------

test("Remove deletes only Forge's own collection", async () => {
  const store = new FakeStore();
  const users = store.existing("Modded", [30]);
  const first = await reconcileModdedCollection(store, null, [10], overview);
  assert.equal(await removeOwnedCollection(store, first.record), true);
  assert.deepEqual(
    store.userCollections.map((c) => c.displayName),
    ["Modded"]
  );
  assert.equal(users.deleted, false);
  // No record, or a record whose collection is gone: nothing is deleted.
  assert.equal(await removeOwnedCollection(store, null), false);
  assert.equal(await removeOwnedCollection(store, first.record), false);
  assert.equal(await removeOwnedCollection(store, { id: "", name: "Modded", added: [] }), false);
  assert.equal(users.deleted, false);
});

// ---- scheduling ---------------------------------------------------------------

function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    set(fn) {
      pending.set(++id, fn);
      return id;
    },
    clear(h) {
      pending.delete(h);
    },
    async fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
      await new Promise((r) => setImmediate(r));
    },
    get count() {
      return pending.size;
    },
  };
}

test("a burst of changes is one run, with every game that changed", async () => {
  const timers = fakeTimers();
  const jobs = [];
  const s = new ModdedScheduler(async (job) => void jobs.push(job), timers);
  s.request("valheim");
  s.request("stardewvalley");
  s.request("valheim");
  assert.equal(timers.count, 1);
  await timers.fire();
  assert.deepEqual(jobs, [{ full: false, domains: ["stardewvalley", "valheim"] }]);
});

test("a change that names no game asks for a full recount", async () => {
  const timers = fakeTimers();
  const jobs = [];
  const s = new ModdedScheduler(async (job) => void jobs.push(job), timers);
  s.request("");
  await timers.fire();
  s.request(null);
  await timers.fire();
  assert.deepEqual(jobs.map((j) => j.full), [true, true]);
});

test("runs never overlap: a change during a run runs after it", async () => {
  const timers = fakeTimers();
  const jobs = [];
  let release;
  const s = new ModdedScheduler(async (job) => {
    jobs.push(job);
    if (jobs.length === 1) await new Promise((r) => (release = r));
  }, timers);
  s.request("a");
  await timers.fire();
  s.request("b");
  assert.equal(timers.count, 0); // held while the first run is going
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.count, 1);
  await timers.fire();
  assert.deepEqual(jobs.map((j) => j.domains), [["a"], ["b"]]);
});

test("a failing run does not stop the next one", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const s = new ModdedScheduler(async () => {
    calls += 1;
    throw new Error("Steam said no");
  }, timers);
  s.request("a");
  await timers.fire();
  s.request("a");
  await timers.fire();
  assert.equal(calls, 2);
});

test("cancel drops what was waiting", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const s = new ModdedScheduler(async () => void (calls += 1), timers);
  s.request("a");
  s.cancel();
  await timers.fire();
  assert.equal(calls, 0);
});

// ---- wiring ---------------------------------------------------------------------

const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const readCode = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:'"\\])\/\/[^\n]*/gm, "$1");

test("the wiring never names a collection to delete except through the recorded id", () => {
  const sync = readCode("moddedSync.ts");
  assert.doesNotMatch(sync, /\.Delete\(/);
  assert.match(sync, /removeOwnedCollection\(store, toOwned\(st\.collection\)\)/);
  // Offline: the only backend calls are local ones (disk and forge.json).
  const imported = /import \{([^}]*)\} from "\.\/api"/.exec(sync)[1]
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const local = new Set([
    "ForgeModdedCollectionRecord",
    "forgeModdedState",
    "forgeNoteModded",
    "forgeSetModdedCollection",
    "getInstalledMods",
  ]);
  for (const name of imported) assert.ok(local.has(name), name);
  assert.doesNotMatch(sync, /fetch\(|graphql/i);
});

test("the switch is on by default and lives with the other game-page switches", () => {
  assert.match(read("forgeSettings.ts"), /moddedCollection: "forge\.moddedCollection"/);
  const settings = read("SettingsPage.tsx");
  assert.match(settings, /name="moddedCollection"/);
  assert.match(settings, /Turning this off leaves the collection as it is/);
  assert.match(settings, /Remove Modded collection/);
});
