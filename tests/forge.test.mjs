// Forge frontend rules: the game page Mods section, tile dots, the patch's
// failure budget and how B leaves pages opened from the game page.
// Run via: pnpm run test:forge (compiles src/forgeRules.ts and
// src/navRules.ts standalone, then executes this file)
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

import {
  CARD_ACTION_LABELS,
  CARD_MAX_BUTTONS,
  CARD_TEXT,
  ROW_HEIGHT,
  compactButtons,
  detailLines,
  lockLineActions,
  lockModalActions,
  lockSummary,
  rowPress,
  savesHint,
  statusChips,
  FailureBudget,
  FORGE_BLACK,
  FORGE_CRIMSON,
  FORGE_GUNMETAL,
  FORGE_STEEL,
  GAME_PAGE_ROWS,
  OPTISCALER_REFUSED,
  optiscalerLine,
  PATCH_FAILURE_LIMIT,
  SAVE_BACKUP_HINT,
  appsWithUpdates,
  backupAge,
  backupFailToast,
  backupRowLabel,
  countLabel,
  dotCss,
  lockBody,
  lockHeadline,
  modSet,
  overrideLabel,
  offerBody,
  restoreConfirmBody,
  rowsToShow,
  saveBackupLine,
  sectionMode,
  skipWindowLabel,
  undoOutcome,
  LOAD_ORDER_APP_IDS,
  firstWarning,
  loadOrderSupported,
  masterlistLine,
  profileSwitchBlocked,
  profileSwitchSummary,
  sortOutcome,
  warningSummary,
} from "../.test-build/forgeRules.js";
import { exitReturnsToGamePage } from "../.test-build/navRules.js";

const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const readCode = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:'"\\])\/\/[^\n]*/gm, "$1");

// ---- palette ---------------------------------------------------------------

test("forgeRules' palette copies match palette.ts (the one token module)", () => {
  const pal = read("palette.ts");
  const token = (name) => {
    const m = pal.match(new RegExp(`export const ${name} = "(#[0-9A-Fa-f]{6})";`));
    assert.ok(m, `palette.ts no longer defines ${name}`);
    return m[1].toUpperCase();
  };
  assert.equal(FORGE_BLACK.toUpperCase(), token("BLACK"));
  assert.equal(FORGE_CRIMSON.toUpperCase(), token("CRIMSON"));
  assert.equal(FORGE_GUNMETAL.toUpperCase(), token("GUNMETAL"));
  assert.equal(FORGE_STEEL.toUpperCase(), token("STEEL"));
});

test("no colour literal in src outside palette.ts and forgeRules' copies", () => {
  const dir = new URL("../src/", import.meta.url);
  const offenders = [];
  for (const f of readdirSync(dir)) {
    if (!/\.tsx?$/.test(f) || f === "palette.ts" || f === "forgeRules.ts") continue;
    const code = readCode(f);
    const hits = code.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g);
    if (hits) offenders.push(`${f}: ${hits.join(", ")}`);
  }
  assert.deepEqual(offenders, [], "colours belong in palette.ts");
});

// ---- failure budget ---------------------------------------------------------

test("the patch switches itself off after the failure limit, and says so once", () => {
  const b = new FailureBudget();
  const exhausted = [];
  for (let i = 0; i < PATCH_FAILURE_LIMIT + 2; i++) exhausted.push(b.fail());
  assert.equal(exhausted.filter(Boolean).length, 1);
  assert.equal(exhausted.indexOf(true), PATCH_FAILURE_LIMIT - 1);
  assert.ok(b.disabled);
  assert.ok(!new FailureBudget().disabled);
});

// ---- section mode -------------------------------------------------------------

test("the section shows only where it has something to say", () => {
  const m = (o) => sectionMode({ managed: false, locked: false, experimental: false, enabledSetting: true, ...o });
  assert.equal(m({}), "hidden");
  assert.equal(m({ managed: true }), "mods");
  assert.equal(m({ managed: true, locked: true }), "locked");
  assert.equal(m({ experimental: true }), "setup");
  assert.equal(m({ experimental: true, locked: true }), "locked");
  // An unmanaged locked game with any-game mode off is not ours to talk about.
  assert.equal(m({ locked: true }), "hidden");
  assert.equal(m({ managed: true, locked: true, enabledSetting: false }), "hidden");
});

test("the crash guard's mod set leaves out mods without a switch", () => {
  assert.deepEqual(
    modSet([
      { folder: "A", enabled: true },
      { folder: "B", enabled: false },
      { folder: "SKSE", enabled: true, togglable: false },
    ]),
    { A: true, B: false }
  );
});

test("the game page lists updates first, then mods that are on, and stops early", () => {
  const mods = Array.from({ length: 10 }, (_, i) => ({ folder: `m${i}`, enabled: i % 2 === 0 }));
  const rows = rowsToShow(mods, new Set(["m9"]));
  assert.equal(rows.length, GAME_PAGE_ROWS);
  assert.equal(rows[0].folder, "m9");
  assert.ok(rows.slice(1).every((r) => r.enabled));
  assert.equal(countLabel(mods), "5 of 10 on");
  assert.equal(countLabel([]), "No mods installed");
});

// ---- anti-cheat wording --------------------------------------------------------

test("the lock says what was found and that switching off still works", () => {
  const listed = { detected: true, locked: true, products: ["Easy Anti-Cheat"], source: "list", override_allowed: true, override_on: false };
  assert.match(lockHeadline(listed), /Easy Anti-Cheat/);
  assert.match(lockBody(listed), /known to run anti-cheat/);
  assert.match(lockBody(listed), /Switching mods off still works/);
  const folder = { ...listed, source: "folder", marker: "BattlEye" };
  assert.match(lockBody(folder), /BattlEye/);
});

test("the one-press bypass states the risk on the button itself", () => {
  const base = { detected: true, locked: true, products: ["Ricochet"], source: "list", override_allowed: true, override_on: false };
  assert.match(overrideLabel({ ...base, risk: "ban" }), /may get this account banned/);
  assert.match(overrideLabel({ ...base, risk: "offline" }), /offline only/);
  assert.doesNotMatch(overrideLabel({ ...base, risk: "offline" }), /banned/);
  assert.match(lockBody({ ...base, risk: "ban" }), /can get the account banned/);
});

// ---- restore offer --------------------------------------------------------------

test("the restore offer promises only switching, and names what changes", () => {
  const plan = { changes: [{ folder: "a", enabled: false }, { folder: "b", enabled: true }], missing: ["gone"], lkg_at: 0, vanilla: false };
  const body = offerBody(plan, { a: "Alpha" });
  assert.match(body, /switch off 1 \(Alpha\)/);
  assert.match(body, /switch back on 1/);
  assert.match(body, /1 mod was removed since and stays removed/);
  assert.match(body, /Nothing is deleted/);
  assert.match(offerBody({ changes: [], missing: [], lkg_at: 0, vanilla: true }), /every mod off/);
});

// ---- tile dots ---------------------------------------------------------------------

test("tile dots: one rule, crimson on black, only for games with updates", () => {
  assert.equal(dotCss([]), "");
  const css = dotCss([1245620, 1245620, -1, 0, 489830]);
  assert.equal((css.match(/library_600x900/g) || []).length, 2);
  assert.ok(css.includes('/1245620/library_600x900'));
  assert.ok(css.includes(FORGE_CRIMSON) && css.includes(FORGE_BLACK));
  assert.ok(css.includes("pointer-events:none"), "a dot must never eat a click");
  assert.ok(!/glow|blur|box-shadow/i.test(css), "no glow or haze");
  assert.deepEqual(
    appsWithUpdates(
      [{ appId: 1, nexusDomain: "a" }, { appId: 2, nexusDomain: "b" }, { appId: 3, nexusDomain: "c" }],
      { a: { count: 2 }, b: { count: 0 } }
    ),
    [1]
  );
});

// ---- navigation ------------------------------------------------------------------------

test("pages opened from the game page go back to it, not to the QAM", () => {
  assert.equal(exitReturnsToGamePage(true), true);
  assert.equal(exitReturnsToGamePage(false), false);
  const tabs = readCode("Tabs.tsx");
  assert.match(tabs, /export function pushFromGamePage/);
  assert.match(tabs, /if \(exitReturnsToGamePage\(fromGamePage\)\)[\s\S]{0,200}NavigateBack\(\)[\s\S]{0,40}return;/);
  // A QAM entry point resets the stack, which must also clear the origin.
  assert.match(tabs, /export function resetTabStack\(\): void \{[\s\S]{0,80}fromGamePage = false/);
  const section = readCode("GameModsSection.tsx");
  assert.ok(!/pushOurPage\(/.test(section), "the section must use pushFromGamePage");
});

// ---- fail-safe patching (source checks: these files need the Steam client) -----

test("the game page patch fails safe and unpatches", () => {
  const src = readCode("gamePagePatch.tsx");
  assert.match(src, /routerHook\.addPatch\(ROUTE/);
  assert.match(src, /routerHook\.removePatch\(ROUTE, patch\)/);
  assert.match(src, /getDerivedStateFromError/);
  assert.match(src, /<ForgeBoundary key=\{KEY\}>/);
  assert.match(src, /if \(at < 0\) return ret;/, "no overview panel: insert nothing");
  assert.match(src, /c\?\.key === KEY/, "never inserted twice");
  assert.ok((src.match(/catch \(e\)/g) || []).length >= 4, "every step is guarded");
  assert.match(src, /budget\.disabled/);
  const index = readCode("index.tsx");
  const dismount = index.slice(index.indexOf("onDismount()"));
  assert.match(dismount, /unregisterGamePagePatch\(\)/);
  assert.match(dismount, /stopForge\(\)/);
});

test("the section never takes focus from Play", () => {
  const src = readCode("GameModsSection.tsx");
  assert.ok(!/autoFocus/.test(src));
  assert.ok(!/\.focus\(\)/.test(src));
});

test("mods are switched through install.ts, and the bypass is one press in the lock's Why? modal", () => {
  const src = readCode("GameModsSection.tsx");
  assert.match(src, /import \{ toggleMod \} from "\.\/install"/);
  // The override lives in LockWhyModal and nowhere else on the game page.
  const start = src.indexOf("function LockWhyModal(");
  const end = src.indexOf("\nasync function applyChanges", start);
  assert.ok(start > 0 && end > start, "LockWhyModal is where the override lives");
  const modal = src.slice(start, end);
  const outside = src.slice(0, start) + src.slice(end);
  assert.match(modal, /allowModsAnyway\(appId\)/);
  assert.match(modal, /\{overrideLabel\(ac\)\}/, "the risk is on the button");
  assert.match(modal, /lockModalActions\(ac\)/);
  assert.ok(!/ConfirmModal/.test(modal), "one press inside the modal, no second dialog");
  assert.ok(!/allowModsAnyway/.test(outside.replace(/import \{ allowModsAnyway,/, "import {")), "no override outside the modal");
  assert.ok(!/overrideLabel\(/.test(outside), "the override's label appears only in the modal");
  assert.match(src, /Lock mods again/);
  const qam = readCode("ForgeLock.tsx");
  assert.match(qam, /\{overrideLabel\(v\)\}/);
  assert.match(qam, /Lock mods again/);
  assert.ok(!/showModal|ConfirmModal/.test(qam));
  assert.match(readCode("index.tsx"), /<ForgeLockSection game=\{ctx\.game\} \/>/);
});

test("focus styles use the palette and never glow", () => {
  const src = read("GameModsSection.tsx");
  const css = src.slice(src.indexOf("const CSS = `"), src.indexOf("`;", src.indexOf("const CSS = `")));
  assert.match(css, /box-shadow: none !important/);
  assert.ok(!/rgba\([^)]*\)\s*0 0|0 0 \d+px/.test(css), "no glow");
  assert.match(css, /\$\{FORGE_CRIMSON\}/);
});

test("tile dots go through one style element that is removed on unload", () => {
  const src = readCode("forge.ts");
  assert.match(src, /getElementById\(DOT_STYLE_ID\)/);
  assert.match(src, /return \(\) => \{[\s\S]*writeStyle\(""\);[\s\S]*\};/);
});

// ---- undo after a restore -------------------------------------------------

test("undo clears its record only when every change went back", () => {
  const ok = undoOutcome([]);
  assert.equal(ok.clearRecord, true);
  assert.equal(ok.title, "Mods put back as they were");
  const partial = undoOutcome(["ModA: Mods are locked for this game"]);
  assert.equal(partial.clearRecord, false);
  assert.match(partial.title, /1 mod not restored/);
  assert.match(partial.body, /ModA: Mods are locked/);
  assert.match(partial.body, /try again/);
  const many = undoOutcome(["a: x", "b: x", "c: x", "d: x", "e: x"]);
  assert.equal(many.clearRecord, false);
  assert.match(many.title, /5 mods not restored/);
  assert.match(many.body, /\(\+2 more\)/);
});

test("the game page calls forgeGuardUndone only through undoOutcome's verdict", () => {
  const code = readCode("GameModsSection.tsx");
  const calls = code.match(/forgeGuardUndone\(/g) ?? [];
  assert.equal(calls.length, 1);
  assert.match(code, /if \(outcome\.clearRecord\) await forgeGuardUndone\(appId\)/);
});

// ---- save backups (Ludusavi) --------------------------------------------------

test("save line: silent without Ludusavi, then last backup and a failure note", () => {
  const now = 1_000_000;
  assert.equal(saveBackupLine(false, undefined, now), null);
  assert.deepEqual(saveBackupLine(true, undefined, now), { text: "No save backup yet", failed: "" });
  const ok = { last_backup_at: now - 12 * 60, last_at: now - 12 * 60, last_ok: true, last_error: "" };
  assert.deepEqual(saveBackupLine(true, ok, now), { text: "Last save backup: 12 min ago", failed: "" });
  const failedLater = { last_backup_at: now - 3 * 3600, last_at: now - 60, last_ok: false, last_error: "x" };
  assert.deepEqual(saveBackupLine(true, failedLater, now), {
    text: "Last save backup: 3 h ago",
    failed: "Save backup failed",
  });
});

test("backup ages", () => {
  assert.equal(backupAge(100, 120), "just now");
  assert.equal(backupAge(0, 86400 + 5), "yesterday");
  assert.equal(backupAge(0, 5 * 86400), "5 days ago");
  assert.equal(backupAge(200, 100), "just now");
});

test("restore list rows carry date, age, comment and lock", () => {
  const now = Date.UTC(2026, 10, 26, 12) / 1000;
  const row = backupRowLabel({ at: now - 2 * 86400, comment: "before DLC", locked: true }, now);
  assert.match(row, /2026, \d\d:\d\d \(2 days ago\) - before DLC - kept$/);
  assert.equal(backupRowLabel({ at: 0, when: "sometime" }, now), "sometime");
});

test("restore confirmation says a fresh backup comes first", () => {
  const body = restoreConfirmBody("Hades", "1 Nov 2026, 10:00");
  assert.match(body, /first backs up Hades's current saves/);
  assert.match(body, /nothing is restored/);
});

test("a failed backup is a small note, never a stop", () => {
  assert.deepEqual(backupFailToast("Ludusavi took longer than 60 seconds, so the backup was stopped."), {
    title: "Save backup failed",
    body: "Ludusavi took longer than 60 seconds, so the backup was stopped. The mod change went ahead.",
  });
  assert.equal(backupFailToast("").body, "The mod change went ahead.");
  assert.equal(SAVE_BACKUP_HINT, "Install Ludusavi to back up saves before mod changes");
  assert.equal(skipWindowLabel(0), "Back up before every mod change");
  assert.equal(skipWindowLabel(30), "At most one backup per game every 30 min");
});

// ---- OptiScaler entry ---------------------------------------------------------

test("optiscaler: a refused game shows the crimson line whatever is installed", () => {
  const off = { installed: false };
  assert.deepEqual(optiscalerLine({ allowed: false, installed: off }), {
    tone: "refused",
    text: "Not allowed: anti-cheat (DLL injection)",
  });
  assert.equal(OPTISCALER_REFUSED, "Not allowed: anti-cheat (DLL injection)");
  const inst = { installed: true, upscaler_label: "FSR 4", proxy: "dxgi.dll", version: "v0.9.5" };
  assert.equal(optiscalerLine({ allowed: false, installed: inst }).tone, "refused");
});

test("optiscaler: installed, update and suspect lines", () => {
  const inst = { installed: true, upscaler_label: "FSR 4", proxy: "dxgi.dll", version: "v0.9.5" };
  assert.deepEqual(optiscalerLine({ allowed: true, installed: inst }), {
    tone: "installed",
    text: "FSR 4 - as dxgi.dll - v0.9.5",
  });
  assert.match(optiscalerLine({ allowed: true, installed: inst, update_available: true, latest: "v0.9.6" }).text, /update: v0\.9\.6/);
  const crashed = optiscalerLine({ allowed: true, installed: { ...inst, suspect: { kind: "crash" } } });
  assert.equal(crashed.tone, "suspect");
  assert.match(crashed.text, /crashed/);
  assert.equal(optiscalerLine({ allowed: true, installed: { installed: false } }).tone, "off");
});

// ---- Load order (LOOT rules) and profiles --------------------------------------

test("load order: only the four supported Bethesda games", () => {
  assert.deepEqual(LOAD_ORDER_APP_IDS, [489830, 377160, 1716740, 2623190]);
  assert.equal(loadOrderSupported(489830), true);
  assert.equal(loadOrderSupported(0, "starfield"), true);
  assert.equal(loadOrderSupported(22330, "oblivion"), false);
  assert.equal(loadOrderSupported(22380, "newvegas"), false);
});

test("load order: errors come before warnings, and the summary says which", () => {
  const ws = [
    { plugin: "A.esp", level: "warn", text: "Dirty." },
    { plugin: "A.esp", level: "error", text: "Needs B.esm, which is not installed." },
  ];
  assert.equal(firstWarning(ws).level, "error");
  assert.equal(firstWarning([]), undefined);
  assert.deepEqual(warningSummary({ error: 0, warn: 0 }), { tone: "ok", text: "No problems found" });
  assert.deepEqual(warningSummary({ error: 1, warn: 2 }), { tone: "error", text: "1 problem, 2 warnings" });
  assert.deepEqual(warningSummary({ error: 0, warn: 1 }), { tone: "warn", text: "1 warning" });
});

test("load order: the masterlist line says where the rules come from, offline too", () => {
  const now = 1_000_000;
  assert.match(masterlistLine(undefined, now), /not downloaded yet/);
  assert.match(masterlistLine({ available: false, fetched_at: 0, error: "OSError" }, now), /offline/);
  assert.equal(masterlistLine({ available: true, fetched_at: now - 7200, error: "" }, now), "LOOT masterlist, updated 2 h ago");
  assert.match(masterlistLine({ available: true, fetched_at: now - 90000, error: "offline" }, now), /using the saved copy/);
});

test("load order: sort toasts for a move, nothing to do, and a cycle", () => {
  assert.deepEqual(sortOutcome({ ok: true, moved: 3, masterlist_used: true }), {
    title: "Sorted: 3 plugins moved",
    body: "By LOOT's rules. Undo is on the Load order page.",
  });
  assert.equal(sortOutcome({ ok: true, moved: 0, masterlist_used: false }).title, "Already in order");
  const c = sortOutcome({ ok: false, cycle: ["A.esp", "B.esp", "A.esp"], error: "These plugins ..." });
  assert.equal(c.title, "Not sorted: rules go in a circle");
});

test("profiles: refused while the game runs, summary names what happened", () => {
  assert.match(profileSwitchBlocked(489830, 489830), /Close the game first/);
  assert.equal(profileSwitchBlocked(undefined, 489830), "");
  assert.equal(profileSwitchBlocked(377160, 489830), "");
  const plan = { changes: [{ folder: "A", enabled: true }, { folder: "B", enabled: false }], missing: ["Gone"], new_off: [] };
  assert.deepEqual(profileSwitchSummary("Vanilla+", plan, [], true), {
    title: "Profile: Vanilla+",
    body: "1 mod on, 1 off. Not installed any more: Gone.",
  });
  const bad = profileSwitchSummary("Full modlist", plan, ["A: locked"], false);
  assert.equal(bad.title, "Profile Full modlist, with problems");
  assert.match(bad.body, /The load order was not written/);
});

// ---- compact game page card ------------------------------------------------------

const verdict = (o = {}) => ({ detected: false, locked: false, products: [], override_on: false, override_allowed: false, ...o });
const card = (o = {}) => ({
  mode: "mods",
  managed: true,
  anticheat: verdict(),
  mods: [],
  updates: 0,
  offer: false,
  undo: false,
  savesFound: false,
  lastBackupAt: 0,
  ...o,
});
const cod = card({
  mode: "locked",
  managed: false,
  mods: [],
  anticheat: verdict({ detected: true, locked: true, products: ["Ricochet"], override_allowed: true }),
  savesFound: true,
});
const NOW = 1_800_000_000;
const mods = (on, off) => [
  ...Array.from({ length: on }, (_, i) => ({ folder: `on${i}`, enabled: true })),
  ...Array.from({ length: off }, (_, i) => ({ folder: `off${i}`, enabled: false })),
];

test("collapsed: one 56 px row, text in Steam's meta sizes, at most two buttons", () => {
  assert.equal(ROW_HEIGHT, 56);
  assert.equal(CARD_MAX_BUTTONS, 2);
  for (const [k, v] of Object.entries(CARD_TEXT)) assert.ok(v >= 14 && v <= 18, `${k} ${v}px`);
  assert.ok(CARD_TEXT.body >= 16, "body text matches Steam's meta text");
});

test("collapsed: the status chip says locked, updates, count or not modded", () => {
  assert.deepEqual(statusChips(cod), [{ text: "Locked · Ricochet", tone: "crimson" }]);
  assert.deepEqual(statusChips(card({ mods: mods(3, 1) })), [{ text: "3 enabled", tone: "steel" }]);
  assert.deepEqual(statusChips(card({ mods: mods(3, 0), updates: 2 })), [
    { text: "Updates 2", tone: "amber" },
    { text: "3 enabled", tone: "steel" },
  ]);
  assert.deepEqual(statusChips(card({ mods: [] })), [{ text: "Not modded", tone: "hint" }]);
  assert.deepEqual(statusChips(card({ mods: undefined })), [{ text: "Reading...", tone: "hint" }]);
  assert.deepEqual(statusChips(card({ mods: mods(0, 4) })), [{ text: "All 4 off", tone: "hint" }]);
  assert.deepEqual(statusChips(card({ mode: "setup", managed: false })), [{ text: "Not set up", tone: "hint" }]);
  const lockOff = card({ anticheat: verdict({ detected: true, override_on: true }), mods: mods(1, 0) });
  assert.equal(statusChips(lockOff)[0].text, "Lock off");
  assert.equal(statusChips(lockOff)[0].tone, "crimson");
  // Never more than two chips, whatever is going on.
  assert.ok(statusChips(card({ anticheat: verdict({ detected: true, override_on: true }), offer: true, updates: 5, mods: mods(2, 0) })).length <= 2);
});

test("collapsed: the save backup is a short hint, silent without Ludusavi", () => {
  assert.equal(savesHint(false, 0, NOW), null);
  assert.equal(savesHint(true, 0, NOW), "No save backup yet");
  assert.equal(savesHint(true, NOW - 2 * 3600, NOW), "Saves backed up 2 h ago");
});

test("collapsed: the most relevant two buttons, Mods... first for a managed game", () => {
  assert.deepEqual(compactButtons(card({ mods: mods(2, 0) })), ["mods"]);
  assert.deepEqual(compactButtons(card({ savesFound: true, lastBackupAt: NOW - 60 })), ["mods", "restore-saves"]);
  // No backup yet: no Restore saves... on the row.
  assert.deepEqual(compactButtons(card({ savesFound: true, lastBackupAt: 0 })), ["mods"]);
  // The crash offer outranks everything.
  assert.deepEqual(compactButtons(card({ offer: true, savesFound: true, lastBackupAt: NOW })), ["restore-mods", "mods"]);
  assert.deepEqual(compactButtons(card({ undo: true, savesFound: true, lastBackupAt: NOW })), ["undo-restore", "mods"]);
  assert.deepEqual(compactButtons(card({ mode: "setup", managed: false })), ["setup"]);
  // Call of Duty: not managed, locked, no backup yet.
  assert.deepEqual(compactButtons(cod), ["why"]);
  assert.deepEqual(compactButtons({ ...cod, lastBackupAt: NOW }), ["why", "restore-saves"]);
  for (const c of [cod, card({ offer: true, undo: true, savesFound: true, lastBackupAt: NOW })]) {
    assert.ok(compactButtons(c).length <= CARD_MAX_BUTTONS);
  }
  assert.equal(CARD_ACTION_LABELS.mods, "Mods...");
  assert.equal(CARD_ACTION_LABELS["restore-saves"], "Restore saves...");
});

test("A on the row expands under Play; the one-line fallback above never grows", () => {
  assert.equal(rowPress("below"), "toggle");
  assert.equal(rowPress("above"), "open");
  const src = readCode("GameModsSection.tsx");
  assert.match(src, /const open = press === "toggle" && expanded;/);
  assert.match(src, /\{open && \(/, "details render only when expanded under Play");
  assert.match(src, /useState\(false\)/, "collapsed by default");
});

test("expanded: details are one line each, OptiScaler and Load order live there", () => {
  assert.deepEqual(detailLines(cod), ["lock", "saves", "upscaling", "loadorder"]);
  assert.deepEqual(detailLines(card({ mods: mods(1, 0), savesFound: true })), ["mods", "saves", "upscaling", "loadorder"]);
  assert.deepEqual(
    detailLines(card({ offer: true, undo: true, anticheat: verdict({ detected: true, override_on: true }) })),
    ["override", "offer", "undo", "mods", "upscaling", "loadorder"]
  );
  assert.deepEqual(detailLines(card({ mode: "setup", managed: false })), ["upscaling", "loadorder", "setup"]);
  assert.equal(lockSummary({ products: ["Ricochet"] }), "Ricochet: installing or switching mods on is off");
  // No paragraph on the page: every text span is one line with an ellipsis.
  const src = read("GameModsSection.tsx");
  const css = src.slice(src.indexOf("const CSS = `"), src.indexOf("`;", src.indexOf("const CSS = `")));
  assert.match(css, /\.\$\{TEXT\} \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
  assert.ok(!/flexWrap: "wrap"/.test(src), "rows never wrap");
  assert.ok(!/lockBody\(ac\)/.test(src.slice(0, src.indexOf("function LockWhyModal("))), "the long lock text is only in the modal");
});

test("the anti-cheat override is reachable only through the Why? modal", () => {
  const every = [
    cod,
    { ...cod, managed: true, mods: mods(2, 0), lastBackupAt: NOW },
    card({ anticheat: verdict({ detected: true, override_on: true, override_allowed: true }), offer: true, undo: true }),
  ];
  for (const c of every) {
    assert.ok(!compactButtons(c).includes("allow-anyway"));
    assert.ok(!detailLines(c).includes("allow-anyway"));
  }
  for (const o of [
    { locked: true, managed: true, enabledCount: 3, overrideOn: false },
    { locked: false, managed: true, enabledCount: 0, overrideOn: true },
  ]) {
    assert.ok(!lockLineActions(o).includes("allow-anyway"));
    assert.ok(lockLineActions(o).includes("why"), "the lock line leads to the modal");
  }
  assert.deepEqual(lockModalActions({ locked: true, override_allowed: true, override_on: false }), ["allow-anyway"]);
  assert.deepEqual(lockModalActions({ locked: true, override_allowed: false, override_on: false }), []);
  assert.deepEqual(lockModalActions({ locked: false, override_allowed: true, override_on: true }), ["lock-again"]);
});
