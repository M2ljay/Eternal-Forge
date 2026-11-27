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
  MAX_CARRIERS,
  PLAY_SEARCH_DEPTH,
  PlacementLog,
  PlacementRegistry,
  aboveFallbackShown,
  collectorOwnsPanel,
  findInsertionChildren,
  findPlaySectionSlot,
  gameCarriers,
  hasClass,
  insertAfterPlay,
  isFollowable,
  locatePlaySection,
  outlineTree,
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

test("the patch follows the panel down to Play and keeps the old anchor only as the one-line fallback", () => {
  const src = readFileSync(new URL("../src/gamePagePatch.tsx", import.meta.url), "utf8");
  assert.match(src, /locatePlaySection\(ret, findInReactTree, names\)/);
  assert.match(src, /<GameModsSection appId=\{appId\} placement="below" \/>/);
  assert.match(src, /<GameModsSection appId=\{appId\} placement="above" \/>/);
  assert.match(src, /follow\(1, children\[at\]\.props\.children\)/, "follows the overview panel found by its props");
  assert.match(src, /gameCarriers\(ret\)\) follow\(level \+ 1, carrier\)/, "and the components it hands the game to");
  assert.match(src, /findInsertionChildren\(ret, findInReactTree, innerContainer\(\)\)/, "Decky 3/4 InnerContainer lookup kept");
  assert.match(src, /"basicAppDetailsSectionStylerClasses", \["PlaySection"/);
  assert.match(src, /"playSectionClasses", \["PlayBarDetailLabel", "Container"\]/);
  assert.match(src, /collectorOwnsPanel\(children\)/, "Collector-drawn ROM pages are left alone");
  assert.match(src, /placementLog\.note\(/, "the path used is logged once");
  const section = readFileSync(new URL("../src/GameModsSection.tsx", import.meta.url), "utf8");
  assert.match(section, /placements\.mountBelow\(appId, token\)/);
  assert.match(section, /placements\.isFirstBelow\(appId, token\)/);
  assert.match(section, /aboveFallbackShown\(placements\.hasBelow\(appId\), grace\)/);
  assert.match(section, /placementLog\.noteFallback\(\)/);
});

// ---- Trees shaped like The Collector's TV evidence -------------------------
// [FE] gameDetailPatch: replacing AppDetailsOverviewPanel at index 2 with RomM
// wrapper (cls=_1_cYNJSvS6IXs9vLTEYjy5): InnerContainer's third child is the
// overview panel's wrapper, with a class, holding the panel element whose props
// carry overview + details + bFastRender. The panel's component draws Play and
// the tabs through an inner component (`se`), so Play is one level deeper.

const PANEL_CLS = "_1_cYNJSvS6IXs9vLTEYjy5";
const PLAY = "PlaySection_x1";
const overview = { appid: 489830, app_type: 1 };
const details = { strDisplayName: "Skyrim" };

function Panel() {}
function Inner() {}
function PlayBar() {}
function Tabs() {}
const memoTabs = { $$typeof: Symbol.for("react.memo"), type: Tabs };
const provider = { $$typeof: Symbol.for("react.provider"), _context: {} };

function collectorShapedPage() {
  const panelElement = { type: Panel, props: { overview, details, bFastRender: false } };
  const wrapper = { type: "div", key: null, props: { className: PANEL_CLS, children: panelElement } };
  const children = [
    { type: "div", props: { className: "Header_q" } },
    { type: "div", props: { className: "Spacer_q" } },
    wrapper,
  ];
  const tree = { props: { children: { type: "div", props: { className: "InnerContainer_abc", children } } } };
  return { children, tree, panelElement };
}

// What each component renders (level 1 = the panel).
function renderOf(element) {
  if (element.type === Panel) {
    return { type: provider, props: { value: {}, children: { type: Inner, props: { overview, details } } } };
  }
  if (element.type === Inner) {
    return {
      type: "div",
      props: {
        className: "AppDetailsRoot_q",
        children: [
          { type: "div", key: "play", props: { className: `x ${PLAY}`, children: { type: PlayBar, props: { overview } } } },
          { type: memoTabs, key: "tabs", props: { overview, details } },
        ],
      },
    };
  }
  return null;
}

// The patch's walk, without React: place under Play, else follow the carriers.
function descend(element, names, level = 1, log = []) {
  if (level > PLAY_SEARCH_DEPTH) return { log };
  const ret = renderOf(element);
  log.push(level);
  const match = locatePlaySection(ret, find, names);
  if (match) return { level, match, ret, log };
  for (const carrier of gameCarriers(ret)) {
    const found = descend(carrier, names, level + 1, log);
    if (found.match) return found;
  }
  return { log };
}

test("Collector-shaped tree: the overview panel is found at index 2, by its props, with its class", () => {
  const { children, tree } = collectorShapedPage();
  assert.equal(overviewIndex(children), 2);
  assert.equal(children[2].props.className, PANEL_CLS);
  assert.equal(findInsertionChildren(tree, find, "InnerContainer_abc"), children, "Decky 3.3.1: by class");
  assert.equal(findInsertionChildren(tree, find, "stale"), children, "Decky 4.0: by the panel");
});

test("Collector-shaped tree: Play is not in the panel's own render, it is found one component down", () => {
  const { panelElement } = collectorShapedPage();
  assert.equal(locatePlaySection(renderOf(panelElement), find, [PLAY]), undefined, "the level the old patch looked at");
  const { level, match, ret } = descend(panelElement, [PLAY, "PlayContainer_q"]);
  assert.equal(level, 2);
  assert.equal(match.kind, "slot");
  const section = { type: "forge", key: "forge-mods-below-play" };
  match.slot.children.splice(match.slot.index, 0, section);
  assert.deepEqual(ret.props.children.map((c) => c.key), ["play", "forge-mods-below-play", "tabs"], "after Play, before the tabs");
});

test("Decky 4.0: only the second play class is known, still found one level down", () => {
  const { panelElement } = collectorShapedPage();
  const { level } = descend(panelElement, ["stale", PLAY]);
  assert.equal(level, 2);
});

test("no known play class: the walk stops within the depth limit and the line above takes over", () => {
  const { panelElement } = collectorShapedPage();
  const { match, log } = descend(panelElement, ["stale", undefined]);
  assert.equal(match, undefined);
  assert.ok(Math.max(...log) <= PLAY_SEARCH_DEPTH);
});

test("a component whose own root is the play section: matched as the root (drawn beside it)", () => {
  const root = { type: "div", props: { className: `${PLAY} sticky`, children: [] } };
  assert.deepEqual(locatePlaySection(root, find, [PLAY]), { kind: "root" });
});

test("the outer play class wins over an inner one", () => {
  const inner = { type: "div", props: { className: "PlayContainer_q" } };
  const outer = { type: "div", props: { className: PLAY, children: [inner] } };
  const tree = { type: "div", props: { children: [outer, { type: "div", props: { className: "tabs" } }] } };
  const match = locatePlaySection(tree, find, [PLAY, "PlayContainer_q"]);
  assert.equal(match.slot.children, tree.props.children);
  assert.equal(match.slot.index, 1);
});

test("only components handed the game are followed, never host elements or contexts", () => {
  const { panelElement } = collectorShapedPage();
  const carriers = gameCarriers(renderOf(panelElement));
  assert.deepEqual(carriers.map((c) => c.type), [Inner]);
  const inner = gameCarriers(renderOf({ type: Inner }));
  assert.deepEqual(inner.map((c) => c.type), [PlayBar, memoTabs]);
  assert.ok(isFollowable({ type: Panel }));
  assert.ok(isFollowable({ type: memoTabs }));
  assert.ok(isFollowable({ type: { $$typeof: Symbol.for("react.forward_ref"), render: () => null } }));
  assert.ok(!isFollowable({ type: "div" }));
  assert.ok(!isFollowable({ type: provider }));
  assert.ok(!isFollowable({ type: Symbol.for("react.fragment") }));
  assert.ok(!isFollowable(null));
  const many = { type: "div", props: { children: Array.from({ length: 20 }, () => ({ type: Inner, props: { overview } })) } };
  assert.equal(gameCarriers(many).length, MAX_CARRIERS, "bounded");
  const cyclic = { type: "div", props: {} };
  cyclic.props.children = [cyclic];
  assert.deepEqual(gameCarriers(cyclic), []);
});

test("The Collector's RomM wrapper is recognised, Steam's own panel is not", () => {
  const { children } = collectorShapedPage();
  assert.equal(collectorOwnsPanel(children), false);
  const romm = [...children];
  romm.splice(2, 1, { type: "div", key: "romm-play-section", props: { className: PANEL_CLS, "data-romm": "true" } });
  assert.equal(collectorOwnsPanel(romm), true);
  assert.equal(overviewIndex(romm), -1, "and nothing is followed there");
});

test("two copies under Play: only the first mounted is drawn, the next takes over on unmount", () => {
  const reg = new PlacementRegistry();
  const a = {};
  const b = {};
  const ra = reg.mountBelow(7, a);
  reg.mountBelow(7, b);
  assert.ok(reg.isFirstBelow(7, a));
  assert.ok(!reg.isFirstBelow(7, b));
  ra();
  assert.ok(reg.isFirstBelow(7, b));
  assert.ok(reg.hasBelow(7));
  assert.ok(!reg.isFirstBelow(8, b));
});

test("the path used is logged once; the fallback line carries the panel outline", () => {
  const lines = [];
  const log = new PlacementLog((m) => lines.push(m));
  assert.ok(log.note("under Play (level 2)"));
  assert.ok(!log.note("under Play (level 2)"));
  const { panelElement } = collectorShapedPage();
  log.rememberOutline(outlineTree(renderOf(panelElement)));
  assert.ok(log.noteFallback());
  assert.ok(!log.noteFallback());
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Forge game page: Mods row under Play/);
  assert.match(lines[1], /above the Play bar \(fallback\)/);
  assert.match(lines[1], /Inner \{overview,details\}/, "outline names the inner component and its props");
  const throwing = new PlacementLog(() => {
    throw new Error("no console");
  });
  assert.doesNotThrow(() => throwing.note("x"));
});

test("the outline is bounded and survives odd nodes", () => {
  const deep = { type: "div", props: {} };
  let node = deep;
  for (let i = 0; i < 50; i++) {
    node.props.children = { type: "div", props: { className: `d${i}` } };
    node = node.props.children;
  }
  assert.ok(outlineTree(deep, 6).length <= 7);
  const wide = { type: "div", props: { children: Array.from({ length: 200 }, () => ({ type: "span", props: {} })) } };
  assert.equal(outlineTree(wide, 6, 60).length, 60);
  assert.deepEqual(outlineTree(null), []);
});
