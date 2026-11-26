// Forge frontend rules: the game page Mods section, tile dots, the patch's
// failure budget and how B leaves pages opened from the game page.
// Run via: pnpm run test:forge (compiles src/forgeRules.ts and
// src/navRules.ts standalone, then executes this file)
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  FailureBudget,
  FORGE_BLACK,
  FORGE_CRIMSON,
  GAME_PAGE_ROWS,
  PATCH_FAILURE_LIMIT,
  appsWithUpdates,
  countLabel,
  dotCss,
  lockBody,
  lockHeadline,
  modSet,
  overrideLabel,
  offerBody,
  rowsToShow,
  sectionMode,
  undoOutcome,
} from "../.test-build/forgeRules.js";
import { exitReturnsToGamePage } from "../.test-build/navRules.js";

const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const readCode = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:'"\\])\/\/[^\n]*/gm, "$1");

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

test("mods are switched through install.ts, and the bypass is one press with its risk as the label", () => {
  const src = readCode("GameModsSection.tsx");
  assert.match(src, /import \{ toggleMod \} from "\.\/install"/);
  assert.match(src, /onClick=\{allowAnyway\}>\s*\{overrideLabel\(ac\)\}/);
  const allow = src.slice(src.indexOf("const allowAnyway"), src.indexOf("const relock"));
  assert.ok(!/showModal|ConfirmModal/.test(allow), "no dialog in front of the bypass");
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
