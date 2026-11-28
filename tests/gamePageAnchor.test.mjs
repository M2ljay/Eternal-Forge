// Game-page anchor tests. Run via: pnpm run test:anchor
// (compiles src/gamePageAnchor.ts standalone, then executes this file)
// Decky 3.3.1 hands plugins @decky/ui 4 (webpack Steam), Decky 4.0 hands them
// @decky/ui 5 (ES-module Steam, renamed classes). Both must find the page, a
// page without the overview panel must get nothing, and (anygame.77) Forge
// goes only to screen two: Steam's tab row and section cards, never screen one.
import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import {
  CARD_INDEX,
  CARRIER_DEPTH,
  MAX_CARRIERS,
  PlacementLog,
  PlacementRegistry,
  SCOUT_TRIES_MS,
  ScreenTwoPaths,
  addCardToFirstTab,
  collectorOwnsPanel,
  componentPath,
  discoverScreenTwo,
  fiberOf,
  findInsertionChildren,
  findSectionHost,
  gameCarriers,
  hasClass,
  insertCard,
  isFollowable,
  isOverviewFiber,
  outlineTree,
  overviewIndex,
  pathElements,
  resolveClassModule,
  findTabContainer,
  firstTabActive,
  addTab,
  tabPageFiber,
  tabSwitcher,
  walkRender,
  SteamTabs,
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

test("Collector-shaped tree: the overview panel is found at index 2, by its props, with its class", () => {
  const { children, tree } = collectorShapedPage();
  assert.equal(overviewIndex(children), 2);
  assert.equal(children[2].props.className, PANEL_CLS);
  assert.equal(findInsertionChildren(tree, find, "InnerContainer_abc"), children, "Decky 3.3.1: by class");
  assert.equal(findInsertionChildren(tree, find, "stale"), children, "Decky 4.0: by the panel");
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


test("two cards mounted: only the first is drawn, the next takes over on unmount", () => {
  const reg = new PlacementRegistry();
  let calls = 0;
  const unsub = reg.subscribe(() => calls++);
  const a = {};
  const b = {};
  const ra = reg.mount(7, a);
  const rb = reg.mount(7, b);
  assert.ok(reg.isFirst(7, a));
  assert.ok(!reg.isFirst(7, b));
  ra();
  ra();
  assert.ok(reg.isFirst(7, b), "unmount is idempotent and hands over");
  assert.ok(reg.has(7));
  assert.ok(!reg.isFirst(8, b));
  rb();
  assert.ok(!reg.has(7));
  unsub();
  reg.mount(7);
  assert.equal(calls, 4);
});

test("where Forge went is logged once; 'nothing shown' carries the page outline", () => {
  const lines = [];
  const log = new PlacementLog((m) => lines.push(m));
  assert.ok(log.note("tab in Steam's tab row (3 below the overview panel)"));
  assert.ok(!log.note("tab in Steam's tab row (3 below the overview panel)"));
  const { panelElement } = collectorShapedPage();
  log.rememberOutline(outlineTree(renderOf(panelElement)));
  assert.ok(log.noteNothing(["screen two: container not found", "tab row not found"]));
  assert.ok(!log.noteNothing(["again"]), "once per session");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Forge game page: Mods tab in Steam's tab row/);
  assert.match(lines[1], /not shown: neither Steam's tab row nor its section cards/);
  assert.match(lines[1], /nothing is drawn on screen one/);
  assert.match(lines[1], /screen two: container not found\ntab row not found\noverview panel render:/);
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



// ---- Screen two (anygame.77) -------------------------------------------------
// The TV (anygame.72-.76): the carrier search (components handed `overview` /
// `details`) never reached Steam's tabs, so the one-line row showed over the
// art. These trees reproduce that: the overview panel hands the game to no
// one, the tabbed page sits inside AppDetailsContainer three components down,
// and the section cards are a tab's content. The scout's DOM + fiber climb
// names the way; the patch then follows it.

function Layout() {}
function Body() {}
function Focus() {}
const memoFocus = { $$typeof: Symbol.for("react.memo"), type: Focus };
function TabbedPage() {}
function Sections() {}
function Section() {}

const shown = [];
function tvTabbedPage() {
  return {
    type: TabbedPage,
    props: {
      tabs: [
        { id: "activity", title: "Activity", content: { type: Sections, props: {} } },
        { id: "info", title: "Game Info", content: "b" },
      ],
      activeTab: "activity",
      onShowTab: (id) => shown.push(id),
    },
  };
}

// What each component renders on the TV-shaped page (level 1 = the panel).
function renderTV(element) {
  switch (element?.type) {
    case Panel:
      return { type: provider, props: { value: {}, children: { type: Layout, props: { appid: 489830 } } } };
    case Layout:
      return {
        type: "div",
        props: {
          className: "AppDetailsRoot_q",
          children: [
            { type: "div", key: "play", props: { className: `x ${PLAY}`, children: "Play" } },
            { type: "div", key: "two", props: { className: "AppDetailsContainer_q", children: { type: Body, props: {} } } },
          ],
        },
      };
    case Body:
      return { type: memoFocus, props: { children: tvTabbedPage() } };
    case memoFocus:
      return element.props.children;
    case TabbedPage:
      return { type: "div", props: { className: "TabRow_q", children: [] } };
    case Sections:
      return {
        type: "div",
        props: {
          className: "AppDetailSectionList_q",
          children: [
            { type: Section, key: "ach", props: { title: "Achievements" } },
            { type: Section, key: "cloud", props: { title: "Cloud saves" } },
          ],
        },
      };
    default:
      return null;
  }
}

const FORGE_CARD = { type: "forge-card", key: "forge-mods-card", props: {} };

// The patch's walk, without React: the tab into a tab container, the card into
// the section list, then the game carriers (within CARRIER_DEPTH) and the
// discovered path's components one level further.
function simulate(types, sectionHost, render = renderTV) {
  const placed = { tab: undefined, card: undefined, visited: [] };
  const visit = (el, depth) => {
    if (depth > 40) return;
    const ret = render(el);
    if (!ret) return;
    placed.visited.push(depth);
    const tabs = findTabContainer(ret);
    if (tabs && addTab(tabs, "forge-mods", "Mods", "TAB")) placed.tab = { depth, tabs };
    const host = findSectionHost(ret, sectionHost);
    if (host && insertCard(host, FORGE_CARD, FORGE_CARD.key) >= 0) placed.card = { depth, host };
    const next = new Set(pathElements(ret, types));
    if (depth < CARRIER_DEPTH) for (const c of gameCarriers(ret)) next.add(c);
    for (const n of next) visit(n, depth + 1);
  };
  visit({ type: Panel, props: { overview, details, bFastRender: false } }, 1);
  return placed;
}

// A fake DOM with React fibers, shaped like the TV page.
let fiberKey = 0;
function el(className, fiber, children = []) {
  const node = { className, children, parentElement: null };
  node[`__reactFiber$k${fiberKey++}`] = fiber;
  for (const c of children) c.parentElement = node;
  node.querySelector = (sel) => {
    const cls = sel.replace(/^\./, "");
    const walk = (n) => {
      for (const c of n.children) {
        if (typeof c.className === "string" && c.className.split(/\s+/).includes(cls)) return c;
        const deep = walk(c);
        if (deep) return deep;
      }
      return null;
    };
    return walk(node);
  };
  return node;
}

function tvDom({ layoutType = Layout, withListClass = true } = {}) {
  const f = (elementType, memoizedProps, ret) => ({ elementType, type: elementType, memoizedProps, return: ret });
  const panelFiber = f(Panel, { overview, details, bFastRender: false }, f("div", { className: "InnerContainer_abc" }, null));
  const providerFiber = f(provider, { value: {} }, panelFiber);
  const layoutFiber = f(layoutType, { appid: 489830 }, providerFiber);
  const rootHost = f("div", { className: "AppDetailsRoot_q" }, layoutFiber);
  const containerHost = f("div", { className: "AppDetailsContainer_q" }, rootHost);
  const bodyFiber = f(Body, {}, containerHost);
  const focusFiber = f(memoFocus, {}, bodyFiber);
  const tabbedFiber = f(TabbedPage, tvTabbedPage().props, focusFiber);
  const tabRowHost = f("div", { className: "TabRow_q" }, tabbedFiber);
  const sectionsFiber = f(Sections, {}, tabbedFiber);
  const listClass = withListClass ? "AppDetailSectionList_q" : "x9Sections";
  const listHost = f("div", { className: listClass }, sectionsFiber);
  const sectionHost = f("div", { className: "AppDetailsSection_q" }, f(Section, {}, listHost));
  const dom = el("InnerContainer_abc", panelFiber.return, [
    el("Header_q", null),
    el("AppDetailsRoot_q", rootHost, [
      el(`x ${PLAY}`, null),
      el("AppDetailsContainer_q", containerHost, [
        el("TabRow_q", tabRowHost, [el("Tab_q", null)]),
        el(listClass, listHost, [el("AppDetailsSection_q", sectionHost), el("AppDetailsSection_q", sectionHost)]),
      ]),
    ]),
  ]);
  return { dom, panelFiber, tabbedFiber, tabRowHost, listHost };
}

const CLS = {
  container: "AppDetailsContainer_q",
  tabRow: ["TabRow_q"],
  sectionList: "AppDetailSectionList_q",
  section: ["AppDetailsSection_q"],
};

test("the TV case: the game-carrier search alone never reaches Steam's tabs or cards", () => {
  const placed = simulate(new Set(), undefined);
  assert.equal(placed.tab, undefined, "no tab found by carriers (what the TV showed)");
  assert.equal(placed.card, undefined);
  assert.ok(Math.max(...placed.visited) <= CARRIER_DEPTH);
});

test("the scout finds screen two by class and names the components down to it", () => {
  const { dom } = tvDom();
  const s = discoverScreenTwo(dom, CLS);
  assert.equal(s.container, true);
  assert.equal(s.tabRow, true);
  assert.deepEqual(s.tabPath, [Layout, Body, memoFocus], "panel (exclusive) down to the tabbed page's parent; contexts and hosts skipped");
  assert.equal(s.sections, true);
  assert.deepEqual(s.sectionPath, [Layout, Body, memoFocus, TabbedPage, Sections]);
  assert.deepEqual(s.sectionHost, { token: "AppDetailSectionList_q" });
});

test("with the scout's path the patch puts the tab in Steam's tab row and the card second among the section cards", () => {
  const { dom } = tvDom();
  const s = discoverScreenTwo(dom, CLS);
  const paths = new ScreenTwoPaths();
  assert.equal(paths.learn(s), true);
  const placed = simulate(paths.types, paths.sectionHost);
  assert.equal(placed.tab.depth, 3, "Body's render holds the tabbed page");
  assert.deepEqual(placed.tab.tabs.node.props.tabs.map((t) => t.id), ["activity", "info", "forge-mods"]);
  assert.equal(CARD_INDEX, 1);
  assert.deepEqual(placed.card.host.props.children.map((c) => c.key), ["ach", "forge-mods-card", "cloud"]);
  // X on the card can switch Steam's tabbed page to Mods.
  const tabs = new SteamTabs();
  tabs.note(1, tabSwitcher(placed.tab.tabs));
  assert.equal(tabs.open(1, "forge-mods"), true);
  assert.deepEqual(shown.slice(-1), ["forge-mods"]);
});

test("NOTHING is drawn on screen one when no anchor is found", () => {
  // A page with no screen two at all (or a Steam build whose classes are unknown).
  const bare = el("InnerContainer_abc", null, [el("Header_q", null), el(`x ${PLAY}`, null)]);
  for (const cls of [CLS, {}]) {
    const s = discoverScreenTwo(bare, cls);
    assert.deepEqual([s.container, s.tabRow, s.sections, s.tabPath, s.sectionPath], [false, false, false, undefined, undefined]);
    assert.ok(s.outline.length >= 3, "what was looked for is kept for the log line");
    assert.equal(new ScreenTwoPaths().learn(s), false);
  }
  const placed = simulate(new Set(), undefined);
  assert.equal(placed.tab, undefined);
  assert.equal(placed.card, undefined);
  // Screen one (the play bar's render) is never written to.
  const layout = renderTV({ type: Layout });
  assert.deepEqual(layout.props.children.map((c) => c.key), ["play", "two"]);
  // And the patch has no other way onto the page: the only element it puts in
  // InnerContainer is the scout, which draws nothing.
  const src = readFileSync(new URL("../src/gamePagePatch.tsx", import.meta.url), "utf8");
  const route = src.slice(src.indexOf("export function registerGamePagePatch"));
  assert.ok(!/<GameModsSection/.test(route), "no Mods element in the route's InnerContainer");
  assert.equal((route.match(/children\.splice\(/g) || []).length, 1);
  assert.match(route, /children\.splice\(at, 0, <ScreenTwoScout key=\{SCOUT_KEY\} appId=\{appId\} \/>\)/);
  const scout = src.slice(src.indexOf("function ScreenTwoScout("), src.indexOf("export function registerGamePagePatch"));
  assert.match(scout, /return <span ref=\{ref\} data-forge-scout="" aria-hidden="true" style=\{\{ display: "none" \}\} \/>;/);
  assert.ok(!/<GameModsSection|<ModsCard/.test(scout));
  assert.match(scout, /placementLog\.noteNothing\(/, "nothing placed: the outline is logged once");
  const section = readFileSync(new URL("../src/GameModsSection.tsx", import.meta.url), "utf8");
  assert.match(section, /placement: "card" \| "tab"/, "only screen-two placements exist");
  assert.ok(!/placement="(above|below)"|AbovePlay|BelowPlay|aboveFallbackShown/.test(src + section), "the row above / under Play is gone");
});

test("the patch follows the panel, the game carriers and the scout's path; tab and card only on screen two", () => {
  const src = readFileSync(new URL("../src/gamePagePatch.tsx", import.meta.url), "utf8");
  assert.match(src, /follow\(children\[at\]\.props\.children, 1\)/, "follows the overview panel found by its props");
  assert.match(src, /pathElements\(ret, screenTwo\.types\)/, "and the discovered path");
  assert.match(src, /if \(depth < CARRIER_DEPTH\) for \(const c of gameCarriers\(ret\)\) next\.add\(c\)/);
  assert.match(src, /findInsertionChildren\(ret, findInReactTree, innerContainer\(\)\)/, "Decky 3/4 InnerContainer lookup kept");
  assert.match(src, /"basicAppDetailsSectionStylerClasses", \["AppDetailsRoot", "AppDetailsContainer"\]/);
  assert.match(src, /"gamepadTabbedPageClasses", \["GamepadTabbedPage", "TabRow"\]/);
  assert.match(src, /collectorOwnsPanel\(children\)/, "Collector-drawn ROM pages are left alone");
  assert.match(src, /insertCard\(host, card\(appId\), CARD_KEY\)/);
  assert.match(src, /addTab\(\s*tabs,\s*MODS_TAB_ID,/);
  assert.match(src, /placementLog\.note\(/, "where Forge went is logged once");
  const section = readFileSync(new URL("../src/GameModsSection.tsx", import.meta.url), "utf8");
  assert.match(section, /placements\.mount\(appId, token\)/);
  assert.match(section, /placements\.isFirst\(appId, token\)/);
});

test("a patched type in the fibers is named by Steam's own type", () => {
  const Patched = function PatchedLayout() {};
  const { dom } = tvDom({ layoutType: Patched });
  const s = discoverScreenTwo(dom, CLS, (t) => (t === Patched ? Layout : t));
  assert.equal(s.tabPath[0], Layout);
});

test("no AppDetailSectionList class: the section cards' parent is found by its exact class", () => {
  const { dom } = tvDom({ withListClass: false });
  const s = discoverScreenTwo(dom, { ...CLS, sectionList: undefined });
  assert.deepEqual(s.sectionHost, { exact: "x9Sections" });
  const paths = new ScreenTwoPaths();
  paths.learn(s);
  const placed = simulate(paths.types, paths.sectionHost, (e) => {
    const r = renderTV(e);
    if (e?.type === Sections) r.props.className = "x9Sections";
    return r;
  });
  assert.equal(placed.card.host.props.className, "x9Sections");
});

test("fibers: found by React's key, climbs stop at the overview panel, a missing panel gives no path", () => {
  const fiber = { memoizedProps: {} };
  assert.equal(fiberOf({ __reactFiber$abc: fiber }), fiber);
  assert.equal(fiberOf({ __reactInternalInstance$abc: fiber }), fiber);
  assert.equal(fiberOf({}), undefined);
  assert.equal(fiberOf(null), undefined);
  assert.ok(isOverviewFiber({ memoizedProps: { overview: {}, details: {}, bFastRender: false } }));
  assert.ok(!isOverviewFiber({ memoizedProps: { overview: {} } }));
  const orphan = { elementType: Body, memoizedProps: {}, return: { elementType: Layout, memoizedProps: {}, return: null } };
  assert.equal(componentPath(orphan), undefined, "not under the overview panel: no path");
  const { tabRowHost, tabbedFiber } = tvDom();
  assert.equal(tabPageFiber(tabRowHost), tabbedFiber);
  const { panelFiber } = tvDom();
  assert.equal(tabPageFiber({ memoizedProps: {}, return: panelFiber }), undefined, "the climb stops at the panel");
  const cyclic = { elementType: Body, memoizedProps: {} };
  cyclic.return = cyclic;
  assert.equal(componentPath(cyclic), undefined, "bounded");
});

test("walkRender reaches tab contents and element props; pathElements is bounded", () => {
  const inner = { type: Sections, props: {} };
  const tree = { type: "div", props: { header: { type: Section, props: {} }, children: { type: TabbedPage, props: { tabs: [{ id: "a", title: "A", content: inner }, { id: "b", title: "B" }] } } } };
  const seen = [];
  walkRender(tree, (n) => void seen.push(n.type));
  assert.ok(seen.includes(Sections) && seen.includes(Section));
  assert.deepEqual(pathElements(tree, new Set([Sections])), [inner]);
  assert.deepEqual(pathElements(tree, new Set()), []);
  const many = { type: "div", props: { children: Array.from({ length: 50 }, () => ({ type: Body, props: {} })) } };
  assert.equal(pathElements(many, new Set([Body]), 12).length, 12);
  const cyclic = { type: "div", props: {} };
  cyclic.props.children = [cyclic];
  assert.doesNotThrow(() => walkRender(cyclic, () => false));
});

test("the card goes in once, second, whatever the list holds", () => {
  const two = { props: { className: "L", children: [{ key: "a" }, { key: "b" }] } };
  assert.equal(insertCard(two, FORGE_CARD, FORGE_CARD.key), 1);
  assert.equal(insertCard(two, FORGE_CARD, FORGE_CARD.key), -1);
  assert.deepEqual(two.props.children.map((c) => c.key), ["a", "forge-mods-card", "b"]);
  const one = { props: { children: { key: "a" } } };
  assert.equal(insertCard(one, FORGE_CARD, FORGE_CARD.key), 1);
  assert.deepEqual(one.props.children.map((c) => c.key), ["a", "forge-mods-card"]);
  const none = { props: { children: undefined } };
  assert.equal(insertCard(none, FORGE_CARD, FORGE_CARD.key), 0);
  assert.equal(insertCard(null, FORGE_CARD, FORGE_CARD.key), -1);
  assert.ok(hasClass({ props: { className: "a AppDetailSectionList_q" } }, ["AppDetailSectionList_q"]));
  assert.equal(findSectionHost({ props: { className: "AppDetailSectionList_q0", children: [] } }, { token: "AppDetailSectionList_q" }), undefined, "whole classes only");
  assert.equal(findSectionHost({ props: {} }, undefined), undefined);
});

test("no section list but a tabbed page: the card ends the first tab, once; the card belongs to the first tab only", () => {
  const page = tvTabbedPage();
  const c = findTabContainer(page);
  const before = page.props.tabs[0];
  assert.equal(addCardToFirstTab(c, "forge-mods-card", (content) => ["WRAPPED", content]), true);
  assert.equal(addCardToFirstTab(findTabContainer(page), "forge-mods-card", (x) => x), false, "once per render");
  assert.equal(page.props.tabs[0].id, "activity", "Steam's selection is unchanged");
  assert.deepEqual(page.props.tabs[0].content, ["WRAPPED", before.content]);
  assert.equal(before.content.type, Sections, "Steam's own tab object is not changed in place");
  assert.equal(firstTabActive(c), true);
  assert.equal(firstTabActive(findTabContainer({ props: { tabs: page.props.tabs, activeTab: "info" } })), false);
  assert.equal(firstTabActive(findTabContainer({ props: { tabs: page.props.tabs } })), true, "unknown: assume the first");
});

test("the scout keeps looking for a few seconds, and what it learns is kept for the session", () => {
  assert.ok(SCOUT_TRIES_MS.length >= 3);
  assert.ok(SCOUT_TRIES_MS.every((ms, i) => i === 0 || ms > SCOUT_TRIES_MS[i - 1]));
  assert.ok(SCOUT_TRIES_MS[SCOUT_TRIES_MS.length - 1] <= 10000);
  const paths = new ScreenTwoPaths();
  let heard = 0;
  paths.subscribe(() => heard++);
  const s = discoverScreenTwo(tvDom().dom, CLS);
  assert.equal(paths.learn(s), true);
  assert.equal(paths.learn(s), false, "nothing new the second time");
  assert.equal(heard, 1);
  assert.equal(paths.tabFound, true);
});

// ---- Steam's tab container (anygame.72) -------------------------------------

const tabsEl = (extra = {}) => ({
  type: function TabbedPage() {},
  props: {
    tabs: [
      { id: "activity", title: "Activity", content: "a", renderTabAddon: () => null },
      { id: "info", title: "Game Info", content: "b" },
    ],
    activeTab: "activity",
    ...extra,
  },
});

test("a tab container is found by its tabs' shape, deep in a render", () => {
  const el = tabsEl();
  const tree = { props: { children: [{ props: { className: "x" } }, { props: { children: el } }] } };
  const c = findTabContainer(tree);
  assert.equal(c.node, el);
  assert.equal(c.prop, "tabs");
  assert.equal(c.idKey, "id");
  assert.equal(c.titleKey, "title");
});

test("label/key shapes and a sections prop also count", () => {
  const el = { props: { sections: [{ key: "a", label: "A" }, { key: "b", label: "B" }] } };
  const c = findTabContainer({ props: { children: el } });
  assert.equal(c.prop, "sections");
  assert.equal(c.idKey, "key");
  assert.equal(c.titleKey, "label");
});

test("no tab container: one tab, plain arrays and missing titles are not tabs", () => {
  assert.equal(findTabContainer({ props: { tabs: [{ id: "a", title: "A" }] } }), undefined);
  assert.equal(findTabContainer({ props: { tabs: [1, 2] } }), undefined);
  assert.equal(findTabContainer({ props: { tabs: [{ id: "a" }, { id: "b" }] } }), undefined);
  assert.equal(findTabContainer(null), undefined);
});

test("Forge's tab goes last, once, in a new array, without Steam's callbacks", () => {
  const el = tabsEl();
  const before = el.props.tabs;
  const c = findTabContainer(el);
  assert.equal(addTab(c, "forge-mods", "Mods", "CONTENT"), true);
  assert.notEqual(el.props.tabs, before, "Steam's own array is not changed in place");
  assert.equal(before.length, 2);
  const last = el.props.tabs[2];
  assert.deepEqual([last.id, last.title, last.content], ["forge-mods", "Mods", "CONTENT"]);
  assert.equal(last.renderTabAddon, undefined);
  assert.equal(addTab(findTabContainer(el), "forge-mods", "Mods", "X"), false);
  assert.equal(el.props.tabs.length, 3);
});

test("the card's X opens Steam's tab when the container is controlled, else falls back", () => {
  const shown = [];
  const ctl = findTabContainer(tabsEl({ onShowTab: (id) => shown.push(id) }));
  const tabs = new SteamTabs();
  tabs.note(5, tabSwitcher(ctl));
  assert.equal(tabs.open(5, "forge-mods"), true);
  assert.deepEqual(shown, ["forge-mods"]);
  tabs.note(6, tabSwitcher(findTabContainer(tabsEl())));
  assert.equal(tabs.has(6), false);
  assert.equal(tabs.injected(6), true, "the tab is there, Steam just can't be told to show it");
  assert.equal(tabs.open(6, "forge-mods"), false, "uncontrolled: open the tab in place instead");
  tabs.note(7, () => {
    throw new Error("stale");
  });
  assert.equal(tabs.open(7, "forge-mods"), false);
  assert.equal(tabs.has(7), false, "a broken opener is dropped");
  let heard = 0;
  tabs.subscribe(() => heard++);
  tabs.clear(5);
  assert.equal(tabs.injected(5), false);
  assert.equal(heard, 1);
});
