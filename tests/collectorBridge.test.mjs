// Forge on The Collector's ROM pages: registration (present, late, absent,
// reload, unload), the install flow against a fake bridge (entry names only,
// preview before install, refusals shown), removal, the card.
// Run via: pnpm run test:collector
import assert from "node:assert/strict";
import test from "node:test";

import {
  FORGE_CARD_ID,
  FORGE_EXT_ID,
  collectorPageHandled,
  entriesFromPreview,
  failure,
  fileKind,
  installedNames,
  isEntryName,
  isOk,
  newEntries,
  readCollectorMods,
  readGamePage,
  romCardSummary,
  runRomInstall,
  runRomRemove,
  targetsFor,
  watchGamePage,
} from "../.test-build/collectorBridge.js";

// ---- a manual clock for the poll -------------------------------------------
function clock() {
  const timers = [];
  return {
    setTimer: (fn, ms) => {
      const h = { fn, ms, live: true };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      h.live = false;
    },
    tick() {
      const due = timers.splice(0).filter((t) => t.live);
      for (const t of due) t.fn();
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

function gamePage() {
  const registered = [];
  return {
    registered,
    api: {
      version: 1,
      register(ext) {
        registered.push(ext);
        return () => {
          const i = registered.indexOf(ext);
          if (i >= 0) registered.splice(i, 1);
        };
      },
      list: () => registered.slice(),
    },
  };
}

const exts = () => [
  { id: FORGE_EXT_ID, kind: "tab", label: "Mods", render: () => null },
  { id: FORGE_CARD_ID, kind: "overviewCard", label: "Mods", render: () => null },
];

test("present at load: registers the tab and the card at once", () => {
  const win = {};
  const gp = gamePage();
  win.__eternalGamePage = gp.api;
  const c = clock();
  const w = watchGamePage({ getWin: () => win, exts, ...c });
  assert.equal(w.state(), "registered");
  assert.deepEqual(gp.registered.map((e) => e.kind), ["tab", "overviewCard"]);
  // The tab is exactly "forge.mods" (The Collector hides its own Mods button
  // for it); ids are unique across kinds, so the card has its own.
  assert.deepEqual(gp.registered.map((e) => e.id), ["forge.mods", "forge.mods.card"]);
  assert.equal(collectorPageHandled(win), true);
});

test("late: registers when The Collector loads after Forge", () => {
  const win = {};
  const gp = gamePage();
  const c = clock();
  const w = watchGamePage({ getWin: () => win, exts, ...c });
  assert.equal(w.state(), "waiting");
  c.tick();
  assert.equal(gp.registered.length, 0);
  win.__eternalGamePage = gp.api;
  c.tick();
  assert.equal(w.state(), "registered");
  assert.equal(gp.registered.length, 2);
  c.tick();
  assert.equal(gp.registered.length, 2, "registered once, not on every poll");
});

test("absent (old Collector): nothing registers and the Steam patch keeps skipping its pages", () => {
  const win = { __eternalGamePage: { version: 2, register: () => () => {} } };
  const c = clock();
  const w = watchGamePage({ getWin: () => win, exts, ...c });
  c.tick();
  c.tick();
  assert.equal(w.state(), "waiting");
  assert.equal(readGamePage(win), undefined, "another version is not used");
  assert.equal(readGamePage({}), undefined);
  assert.equal(collectorPageHandled({}), false);
});

test("unload unregisters and stops polling", () => {
  const win = {};
  const gp = gamePage();
  win.__eternalGamePage = gp.api;
  const c = clock();
  const w = watchGamePage({ getWin: () => win, exts, ...c });
  w.stop();
  assert.equal(gp.registered.length, 0);
  assert.equal(w.state(), "stopped");
  assert.equal(c.pending(), 0);
});

test("a reloaded Collector (new global) gets a fresh registration", () => {
  const win = {};
  const a = gamePage();
  win.__eternalGamePage = a.api;
  const c = clock();
  const w = watchGamePage({ getWin: () => win, exts, ...c });
  const b = gamePage();
  win.__eternalGamePage = b.api;
  c.tick();
  assert.equal(a.registered.length, 0);
  assert.equal(b.registered.length, 2);
  w.stop();
});

test("a register that throws does not stop the other extension", () => {
  const win = {};
  const regs = [];
  win.__eternalGamePage = {
    version: 1,
    register(ext) {
      if (ext.kind === "tab") throw new Error("no tabs here");
      regs.push(ext);
      return () => {};
    },
  };
  const logs = [];
  const c = clock();
  watchGamePage({ getWin: () => win, exts, ...c, log: (m) => logs.push(m) });
  assert.equal(regs.length, 1);
  assert.ok(logs.some((l) => l.includes("refused forge.mods (tab)")));
});

test("the mods bridge needs version 1 with preview and install", () => {
  assert.equal(readCollectorMods({ __eternalCollectorMods: { version: 1 } }), undefined);
  const api = { version: 1, preview() {}, install() {} };
  assert.equal(readCollectorMods({ __eternalCollectorMods: api }), api);
});

test("answers: success/ok and The Collector's failure wording", () => {
  assert.ok(isOk({ success: true }));
  assert.ok(isOk({ ok: true }));
  assert.ok(!isOk({ success: false }));
  assert.deepEqual(failure({ success: false, reason: "changed", message: "The folder changed" }), {
    reason: "changed",
    message: "The folder changed",
  });
  assert.equal(failure(undefined).reason, "no_answer");
});

test("targets, kinds and names", () => {
  const targets = [
    { target_id: "tex", label: "Texture pack", accepts: "archive_or_folder" },
    { target_id: "patch", label: "Soft patch", accepts: "patch" },
  ];
  assert.deepEqual(targetsFor(targets, "patch").map((t) => t.target_id), ["patch"]);
  assert.deepEqual(targetsFor(targets, "zip").map((t) => t.target_id), ["tex", "patch"], "a zip may hold one soft patch");
  assert.deepEqual(targetsFor(targets, "folder").map((t) => t.target_id), ["tex"]);
  assert.equal(fileKind("a.ZIP"), "zip");
  assert.equal(fileKind("x.bps"), "patch");
  assert.equal(fileKind("x.7z"), "folder");
  assert.deepEqual(newEntries(["A"], ["a", "B"]), ["B"]);
  assert.ok(isEntryName("Forge - HD.zip"));
  for (const bad of ["C:\\Users\\x", "a/b", "..", ""]) assert.ok(!isEntryName(bad), bad);
  assert.deepEqual(installedNames({ targets: [{ target_id: "t", installed: [{ name: "GALE01" }] }] }, "t"), ["GALE01"]);
});

// ---- the install flow against a fake bridge ------------------------------------

function fakeBridge(opts = {}) {
  const calls = [];
  const installed = { tex: ["old.png"] };
  const bridge = {
    version: 1,
    isRomApp: () => true,
    async getTargets(appId) {
      calls.push(["getTargets", appId]);
      return {
        success: true,
        emulator: { label: "Dolphin" },
        targets: [{ target_id: "tex", label: "Texture pack", accepts: "archive_or_folder", installed: installed.tex.map((name) => ({ name })) }],
      };
    },
    async listSources(appId, targetId) {
      calls.push(["listSources", appId, targetId]);
      return opts.sources ?? { success: true, folder: "C:\\Users\\Vonn\\Downloads", entries: [] };
    },
    async preview(appId, source, targetId) {
      calls.push(["preview", appId, source, targetId]);
      return opts.preview ?? { success: true, write_count: 3, total_bytes: 900, replace_count: 1, backup_root: "romm-mod-backups", fingerprint: "fp1" };
    },
    async install(appId, source, targetId, fp) {
      calls.push(["install", appId, source, targetId, fp]);
      if (opts.installSeq?.length) return opts.installSeq.shift();
      if (opts.install) return opts.install;
      installed.tex.push("GALE01");
      return { success: true, written: 3, backed_up: 1, backup_folder: "B" };
    },
    async remove(appId, targetId, name) {
      calls.push(["remove", appId, targetId, name]);
      return opts.remove ?? { success: true, removed: name, backup_folder: "B" };
    },
  };
  return { bridge, calls };
}

function deps(bridge, over = {}) {
  const log = { staged: [], unstaged: [], records: [], confirmed: [] };
  return {
    log,
    d: {
      bridge,
      async stage(file, source, folder) {
        log.staged.push([file.file_id, source, folder]);
        return { ok: true, entry: "Forge - HD Pack.zip" };
      },
      async unstage(entry) {
        log.unstaged.push(entry);
      },
      async record(rec) {
        log.records.push(rec);
        return { ok: true };
      },
      async confirm(preview, entry) {
        log.confirmed.push([preview.fingerprint, entry]);
        return true;
      },
      ...over,
    },
  };
}

const gbArgs = {
  appId: 3000000001,
  romId: 42,
  source: "gamebanana",
  file: { mod_id: 1000000005, file_id: 1000000009, file_name: "pack.zip", name: "HD Pack", version: "2", date: 99 },
  target: { target_id: "tex", label: "Texture pack" },
};

test("install: stage, preview, confirm, install, record - in that order, names only", async () => {
  const { bridge, calls } = fakeBridge();
  const { d, log } = deps(bridge);
  const r = await runRomInstall(d, gbArgs);
  assert.equal(r.ok, true);
  assert.deepEqual(r.entries, ["GALE01"]);
  const order = calls.map((c) => c[0]);
  assert.ok(order.indexOf("preview") < order.indexOf("install"), "preview before install");
  assert.deepEqual(log.confirmed, [["fp1", "Forge - HD Pack.zip"]]);
  // The Collector only ever sees an entry name and a target id.
  for (const c of calls.filter((c) => c[0] === "preview" || c[0] === "install")) {
    assert.equal(c[2], "Forge - HD Pack.zip");
    assert.ok(!/[\\/:]/.test(c[2]), "no path handed to The Collector");
  }
  assert.equal(calls.find((c) => c[0] === "install")[4], "fp1", "installs what was previewed");
  // The folder The Collector listed goes to Forge's own backend, not back.
  assert.equal(log.staged[0][2], "C:\\Users\\Vonn\\Downloads");
  assert.equal(log.records[0].source, "gamebanana");
  assert.equal(log.records[0].file_id, 1000000009);
  assert.deepEqual(log.records[0].entries, ["GALE01"]);
  assert.deepEqual(log.unstaged, ["Forge - HD Pack.zip"], "Forge's staged copy is taken away again");
});

test("install: a refused preview is shown with The Collector's words and nothing is installed", async () => {
  const { bridge, calls } = fakeBridge({ preview: { success: false, reason: "unsafe_entry", message: "An entry would land outside the folder" } });
  const { d, log } = deps(bridge);
  const r = await runRomInstall(d, gbArgs);
  assert.deepEqual(r, { ok: false, step: "preview", reason: "unsafe_entry", message: "An entry would land outside the folder" });
  assert.ok(!calls.some((c) => c[0] === "install"));
  assert.equal(log.confirmed.length, 0);
  assert.equal(log.records.length, 0);
  assert.deepEqual(log.unstaged, ["Forge - HD Pack.zip"]);
});

test("install: backing out of the preview installs nothing", async () => {
  const { bridge, calls } = fakeBridge();
  const { d, log } = deps(bridge, { confirm: async () => false });
  const r = await runRomInstall(d, gbArgs);
  assert.equal(r.step, "cancelled");
  assert.ok(!calls.some((c) => c[0] === "install"));
  assert.equal(log.records.length, 0);
});

test("install: an install refusal (changed since the preview) comes back as is", async () => {
  const { bridge } = fakeBridge({ install: { success: false, reason: "changed", message: "The archive changed since the preview" } });
  const { d, log } = deps(bridge);
  const r = await runRomInstall(d, gbArgs);
  assert.deepEqual(r, { ok: false, step: "install", reason: "changed", message: "The archive changed since the preview" });
  assert.equal(log.records.length, 0);
});

test("install: Downloads unreadable stops before any download", async () => {
  const { bridge } = fakeBridge({ sources: { success: false, reason: "unsupported", message: "Not on this launcher" } });
  const { d, log } = deps(bridge);
  const r = await runRomInstall(d, gbArgs);
  assert.equal(r.step, "sources");
  assert.equal(r.message, "Not on this launcher");
  assert.equal(log.staged.length, 0);
});

test("install: a failed download is shown and The Collector is never asked", async () => {
  const { bridge, calls } = fakeBridge();
  const { d } = deps(bridge, { stage: async () => ({ ok: false, error: "Premium needed" }) });
  const r = await runRomInstall(d, gbArgs);
  assert.deepEqual(r, { ok: false, step: "download", reason: "download", message: "Premium needed" });
  assert.ok(!calls.some((c) => c[0] === "preview"));
});

test("install: the user's own Downloads entry is not staged and not removed", async () => {
  const { bridge, calls } = fakeBridge();
  const { d, log } = deps(bridge);
  const r = await runRomInstall(d, { appId: 1, source: "local", entry: "MyPack.zip", target: { target_id: "tex", label: "T" } });
  assert.equal(r.ok, true);
  assert.equal(log.staged.length, 0);
  assert.equal(log.unstaged.length, 0, "never removes the user's own file");
  assert.equal(calls.find((c) => c[0] === "preview")[2], "MyPack.zip");
  assert.equal(log.records[0].source, "local");
});

test("install: a path posing as an entry is refused before The Collector sees it", async () => {
  const { bridge, calls } = fakeBridge();
  const { d } = deps(bridge);
  const r = await runRomInstall(d, { appId: 1, source: "local", entry: "C:\\Windows\\x.zip", target: { target_id: "tex", label: "T" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_entry");
  assert.ok(!calls.some((c) => c[0] === "preview"));
});

test("remove: through The Collector's remove, entry by entry, then forgotten", async () => {
  const { bridge, calls } = fakeBridge();
  const forgotten = [];
  const r = await runRomRemove(bridge, 1, { id: "gb:1", target_id: "tex", entries: ["GALE01"] }, async (id) => forgotten.push(id));
  assert.equal(r.ok, true);
  assert.deepEqual(calls.filter((c) => c[0] === "remove"), [["remove", 1, "tex", "GALE01"]]);
  assert.deepEqual(forgotten, ["gb:1"]);
});

test("remove: never removes a whole target for a record without entries", async () => {
  const { bridge, calls } = fakeBridge();
  const r = await runRomRemove(bridge, 1, { id: "x", target_id: "patch", entries: [] }, async () => {});
  assert.equal(r.ok, false);
  assert.ok(!calls.some((c) => c[0] === "remove"));
});

test("remove: a refusal keeps the record", async () => {
  const { bridge } = fakeBridge({ remove: { success: false, reason: "running", message: "Close Dolphin first" } });
  const forgotten = [];
  const r = await runRomRemove(bridge, 1, { id: "x", target_id: "tex", entries: ["A"] }, async (id) => forgotten.push(id));
  assert.equal(r.ok, false);
  assert.equal(r.message, "Close Dolphin first");
  assert.deepEqual(forgotten, []);
});

test("the ROM card: count, updates and one status line", () => {
  const targets = { success: true, emulator: { label: "Dolphin" }, targets: [{ target_id: "t", label: "T" }] };
  assert.deepEqual(romCardSummary({ installed: true, records: [{ id: "a" }, { id: "b" }], updates: 1, targets, bridge: true }), {
    active: 2,
    updates: 1,
    status: { text: "Updates waiting", tone: "warn" },
  });
  assert.equal(romCardSummary({ installed: true, records: [], updates: 0, targets, bridge: true }).status.text, "Ready · Dolphin");
  assert.equal(romCardSummary({ installed: false, records: [], updates: 0, targets, bridge: true }).status.tone, "hint");
  assert.equal(romCardSummary({ installed: true, records: [], updates: 0, bridge: false }).status.text, "Update The Collector to mod ROMs with Forge");
  assert.equal(
    romCardSummary({ installed: true, records: [], updates: 0, targets: { success: false, reason: "unsupported", message: "No known mod folder" }, bridge: true }).status.text,
    "No known mod folder"
  );
  const off = { success: true, targets: [{ target_id: "t", label: "T", setting: { label: "Texture packs", state: "off", can_enable: true } }] };
  assert.equal(romCardSummary({ installed: true, records: [], updates: 0, targets: off, bridge: true }).status.text, "Texture packs is off");
});


test("entries a preview writes: relative and absolute paths, top level only", () => {
  assert.deepEqual(
    entriesFromPreview({
      destination: "C:\\Emu\\User\\Load\\Textures\\GALE01",
      writes: [
        { path: "tex1.png", size: 1, replaces: false },
        { path: "sub\\a.png", size: 1, replaces: true },
        { path: "C:\\Emu\\User\\Load\\Textures\\GALE01\\sub\\b.png", size: 1, replaces: false },
        { path: "D:\\Other\\x.png", size: 1, replaces: false },
      ],
      fingerprint: "f",
    }),
    ["tex1.png", "sub"]
  );
  assert.deepEqual(entriesFromPreview(undefined), []);
});

test("an update keeps the entries it writes again, and only listed names are recorded", async () => {
  const { bridge } = fakeBridge({
    preview: { success: true, fingerprint: "fp", writes: [{ path: "old.png", size: 1, replaces: true }, { path: "ghost.png", size: 1, replaces: false }] },
    install: { success: true, written: 1, backed_up: 1 },
  });
  const { d, log } = deps(bridge);
  const r = await runRomInstall(d, { ...gbArgs, keepEntries: ["old.png", "gone.png"] });
  assert.equal(r.ok, true);
  // old.png is listed by The Collector; ghost.png and gone.png are not.
  assert.deepEqual(log.records[0].entries, ["old.png"]);
});


test("the ready event registers again at once (a reloaded Collector starts empty)", () => {
  const win = {};
  const gp = gamePage();
  win.__eternalGamePage = gp.api;
  const handlers = {};
  const c = clock();
  const w = watchGamePage({
    getWin: () => win,
    exts,
    ...c,
    listen: (ev, fn) => {
      handlers[ev] = fn;
      return () => delete handlers[ev];
    },
  });
  // Same global object, registry emptied (as after a reload that kept it).
  gp.registered.splice(0);
  handlers["eternal_game_page_ready"]();
  assert.equal(gp.registered.length, 2);
  w.stop();
  assert.equal(handlers["eternal_game_page_ready"], undefined, "unload stops listening");
});

test("install: Downloads is listed for the picked target", async () => {
  const { bridge, calls } = fakeBridge();
  const { d } = deps(bridge);
  await runRomInstall(d, gbArgs);
  assert.deepEqual(calls.find((c) => c[0] === "listSources"), ["listSources", 3000000001, "tex"]);
});

test("install: 'changed' means preview again and ask again, then install", async () => {
  const { bridge, calls } = fakeBridge({
    installSeq: [{ success: false, reason: "changed", message: "The archive changed" }],
  });
  const { d, log } = deps(bridge);
  const r = await runRomInstall(d, gbArgs);
  assert.equal(r.ok, true);
  assert.equal(calls.filter((c) => c[0] === "preview").length, 2);
  assert.equal(log.confirmed.length, 2, "the new preview is shown before installing");
});

test("install: 'changed' every time gives up after the bounded re-previews", async () => {
  const changed = { success: false, reason: "changed", message: "Still changing" };
  const { bridge, calls } = fakeBridge({ installSeq: [changed, changed, changed, changed] });
  const { d } = deps(bridge);
  const r = await runRomInstall(d, gbArgs);
  assert.deepEqual(r, { ok: false, step: "install", reason: "changed", message: "Still changing" });
  assert.equal(calls.filter((c) => c[0] === "install").length, 3);
});
