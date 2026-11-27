// Game-page anchor tests. Run via: pnpm run test:anchor
// (compiles src/gamePageAnchor.ts standalone, then executes this file)
// Decky 3.3.1 hands plugins @decky/ui 4 (webpack Steam), Decky 4.0 hands them
// @decky/ui 5 (ES-module Steam, renamed classes). Both must place the section,
// and a page without the overview panel must get nothing.
import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import {
  ABOVE_GRACE_MS,
  PlacementRegistry,
  aboveFallbackShown,
  findInsertionChildren,
  findPlaySectionSlot,
  hasClass,
  insertAfterPlay,
  overviewIndex,
  resolveClassModule,
} from "../.test-build/gamePageAnchor.js";

function find(node, filter, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);
  if (filter(node)) return node;
  for (const child of Object.values(node)) {
    const found = find(child, filter, seen);
    if (found) return found;
  }
  return undefined;
}

const panel = () => ({ props: { className: "panel", children: { props: { overview: { appid: 1 }, details: {}, bFastRender: false } } } });
function page(innerClass) {
  const children = [{ props: { className: "header" } }, panel()];
  return { children, tree: { props: { children: { props: { className: innerClass, children } } } } };
}

test("the overview panel is recognised by its props", () => {
  assert.equal(overviewIndex([{}, panel()]), 1);
  assert.equal(overviewIndex([{ props: { children: { props: { overview: {} } } } }]), -1);
});

test("Decky 3.3.1: InnerContainer is found by its class", () => {
  const { children, tree } = page("x InnerContainer_abc");
  assert.equal(findInsertionChildren(tree, find, "InnerContainer_abc"), children);
});

test("Decky 4.0: a stale or missing class still finds the panel's parent", () => {
  const { children, tree } = page("aqfOaplliDM-");
  assert.equal(findInsertionChildren(tree, find, "stale-class"), children);
  assert.equal(findInsertionChildren(tree, find, undefined), children);
});

test("a page without the overview panel gets nothing", () => {
  const tree = { props: { children: { props: { className: "InnerContainer_abc", children: [{ props: {} }] } } } };
  assert.equal(findInsertionChildren(tree, find, "InnerContainer_abc"), undefined);
  assert.equal(findInsertionChildren(null, find, undefined), undefined);
});

const classes = { InnerContainer: "ic", HeaderLoaded: "hl" };

test("the named class module wins when it has the key", () => {
  let probed = false;
  const ui = { appDetailsClasses: classes, findClassModule: () => { probed = true; } };
  assert.equal(resolveClassModule(ui, "appDetailsClasses", ["InnerContainer"]), classes);
  assert.equal(probed, false);
});

test("Decky 3.3.1 falls back to findClassModule, Decky 4.0 to findVar", () => {
  const pick = (values) => (filter) => values.find((v) => filter(v));
  assert.equal(resolveClassModule({ findClassModule: pick([{ a: "b" }, classes]) }, "appDetailsClasses", ["InnerContainer"]), classes);
  assert.equal(
    resolveClassModule({ appDetailsClasses: {}, findClassModule: () => undefined, findVar: pick([7, null, classes]) }, "appDetailsClasses", ["InnerContainer"]),
    classes
  );
});

test("missing, throwing or wrong answers fail soft", () => {
  const boom = () => { throw new Error("hostile"); };
  assert.equal(resolveClassModule(undefined, "appDetailsClasses", ["InnerContainer"]), undefined);
  assert.equal(resolveClassModule({ findClassModule: boom, findVar: boom }, "appDetailsClasses", ["InnerContainer"]), undefined);
  assert.equal(resolveClassModule({ findClassModule: () => ({ Other: "x" }) }, "appDetailsClasses", ["InnerContainer"]), undefined);
  const hostile = Object.defineProperty({}, "appDetailsClasses", { get: boom });
  assert.equal(resolveClassModule(hostile, "appDetailsClasses", ["InnerContainer"]), undefined);
});

// ---- under the Play bar ---------------------------------------------------------
// The overview panel's own render: hero-free, the play section first, then the
// tabs. Forge goes right after the play section, never before it.

function overviewRender(playClass = "PlaySection_x1 Glassy") {
  const play = { props: { className: playClass, children: "Play" } };
  const tabs = { props: { className: "Tabs_x2" } };
  const children = [play, tabs];
  return { play, tabs, children, tree: { props: { className: "Panel", children: { props: { children } } } } };
}
const forge = { key: "forge-mods-below-play", props: {} };

test("the section goes AFTER the play section, before the tabs", () => {
  const { play, tabs, children, tree } = overviewRender();
  const at = insertAfterPlay(tree, find, ["PlaySection_x1", undefined], forge, forge.key);
  assert.equal(at, 1);
  assert.deepEqual(children, [play, forge, tabs]);
  assert.ok(children.indexOf(forge) > children.indexOf(play), "never above Play");
});

test("it is put in once, whatever Steam re-renders", () => {
  const { children, tree } = overviewRender();
  insertAfterPlay(tree, find, ["PlaySection_x1"], forge, forge.key);
  assert.equal(insertAfterPlay(tree, find, ["PlaySection_x1"], { ...forge }, forge.key), -1);
  assert.equal(children.filter((c) => c.key === forge.key).length, 1);
});

test("Decky 3.3.1 and 4.0: either play section class finds the slot", () => {
  const { tree } = overviewRender("aB3_cont PlayContainer_q");
  assert.equal(findPlaySectionSlot(tree, find, [undefined, "PlayContainer_q"]).index, 1);
  assert.equal(findPlaySectionSlot(tree, find, ["PlaySection_stale", "PlayContainer_q"]).index, 1);
});

test("no play section, a stale class or no class map: nothing is inserted (the line above takes over)", () => {
  const { children, tree } = overviewRender();
  assert.equal(insertAfterPlay(tree, find, ["stale"], forge, forge.key), -1);
  assert.equal(insertAfterPlay(tree, find, [undefined, ""], forge, forge.key), -1);
  assert.equal(insertAfterPlay(null, find, ["PlaySection_x1"], forge, forge.key), -1);
  assert.equal(children.length, 2);
});

test("classes match whole names only", () => {
  assert.ok(hasClass({ props: { className: "a PlaySection_x1 b" } }, ["PlaySection_x1"]));
  assert.ok(!hasClass({ props: { className: "PlaySection_x10" } }, ["PlaySection_x1"]));
  assert.ok(!hasClass({ props: {} }, ["PlaySection_x1"]));
});

test("the line above shows only when nothing is mounted under Play, after the grace period", () => {
  assert.ok(ABOVE_GRACE_MS > 0 && ABOVE_GRACE_MS <= 1500);
  assert.equal(aboveFallbackShown(false, false), false);
  assert.equal(aboveFallbackShown(false, true), true);
  assert.equal(aboveFallbackShown(true, true), false);
  const reg = new PlacementRegistry();
  let calls = 0;
  const unsub = reg.subscribe(() => calls++);
  const a = reg.mountBelow(10);
  const b = reg.mountBelow(10);
  assert.ok(reg.hasBelow(10));
  assert.ok(!reg.hasBelow(11));
  a();
  a();
  assert.ok(reg.hasBelow(10), "a second copy keeps it registered; unmount is idempotent");
  b();
  assert.ok(!reg.hasBelow(10));
  unsub();
  reg.mountBelow(10);
  assert.equal(calls, 4);
});

test("the patch puts the section under Play and keeps the old anchor only as the one-line fallback", () => {
  const src = readFileSync(new URL("../src/gamePagePatch.tsx", import.meta.url), "utf8");
  assert.match(src, /insertAfterPlay\(\s*ret,/);
  assert.match(src, /<GameModsSection appId=\{appId\} placement="below" \/>/);
  assert.match(src, /<GameModsSection appId=\{appId\} placement="above" \/>/);
  assert.match(src, /belowPlay\(\[\], children\[at\]\)/, "follows the overview panel found by its props");
  assert.match(src, /findInsertionChildren\(ret, findInReactTree, innerContainer\(\)\)/, "Decky 3/4 InnerContainer lookup kept");
  assert.match(src, /"basicAppDetailsSectionStylerClasses", \["PlaySection"/);
  assert.match(src, /"playSectionClasses", \["PlayBarDetailLabel", "Container"\]/);
  const section = readFileSync(new URL("../src/GameModsSection.tsx", import.meta.url), "utf8");
  assert.match(section, /useEffect\(\(\) => placements\.mountBelow\(appId\), \[appId\]\)/);
  assert.match(section, /aboveFallbackShown\(placements\.hasBelow\(appId\), grace\)/);
});
