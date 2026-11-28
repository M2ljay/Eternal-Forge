// Puts Forge's Mods tab and Overview card on Steam's game page, the way
// ProtonDB Badges and HLTB for Deck add theirs: a routerHook patch on
// /library/app/:appid.
//
// Where it goes (anygame.77): screen two of Core's game view, never screen
// one. Core 3.3.9 makes screen one the hero art, the logo and a transparent
// play bar, and puts Steam's tab row and section cards one press down
// (Core's docs/eternal/CORE-UI.md, "For Forge"). So Forge adds a "Mods" tab to
// Steam's tabbed page (its `tabs` prop, a new array) and its Overview card
// among the section cards. Order: forgeRules.gamePagePlacement. When neither
// is found, NOTHING is drawn and one diagnostic line is logged.
//
// How it gets there (anygame.78). .77 only followed components down from the
// overview panel along a path an invisible scout learned from the DOM, and the
// TV showed nothing: its class lookup took the first of Steam's duplicate
// class modules, and the path needed a redraw. Now:
// 1. At load, Steam's tabbed page component (a React memo; every copy Steam
//    ships, plus @decky/ui's Tabs) gets Forge's wrapper as its inner type
//    (gamePageAnchor.findTabbedPageComponents / wrapMemo). Every tabbed page
//    mounted afterwards, the first game page after Steam starts included,
//    renders through it; the wrapper passes everything through unchanged.
// 2. The scout (display: none, in InnerContainer) tells the wrapper which
//    tabbed page is this game page's: the first one in the React fibers below
//    the scout (gamePageAnchor.tabbedPagesNear). No class names are needed for
//    that. The confirmed tabbed page then renders with Forge's tab last and the
//    card in its first tab, before the browser paints.
// 3. The section cards are found in the first tab's content by the merged
//    class maps (every duplicate module, gamePageAnchor.resolveClassUnion), or
//    along the path the scout learns from the DOM; else, once the scout is
//    done, the card ends the first tab.
// 4. .77's way (follow the overview panel along the learned path) stays as a
//    second route, for a Steam build whose tabbed page is not a memo.
// Non-Steam shortcuts get the same; a page The Collector draws (a ROM) is left
// to The Collector, which hosts Forge's tab and card through
// window.__eternalGamePage (collectorBridge.ts).
//
// Fail-safe by construction:
// - every step is inside try/catch, and a failure returns Steam's tree
//   exactly as it came in;
// - the tab and the card render inside an error boundary that renders
//   nothing on error;
// - after PATCH_FAILURE_LIMIT failures of either kind in one session the
//   patch stops touching the page until the plugin reloads;
// - if the overview panel is not where it is expected (a soundtrack page,
//   a Steam update that moved things) nothing is inserted at all;
// - InnerContainer is found by its class, or, where the loader's class map
//   lacks it (Decky 4.0's renamed classes), as the overview panel's parent;
// - unregisterGamePagePatch removes the route patch on unload.
import { routerHook } from "@decky/api";
import type { RoutePatch } from "@decky/api";
import * as DFL from "@decky/ui";
import { afterPatch, createReactTreePatcher, findInReactTree } from "@decky/ui";
import {
  Component,
  ErrorInfo,
  ReactNode,
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";

import { GameModsSection } from "./GameModsSection";
import {
  CARRIER_DEPTH,
  CLASS_MAP_SPECS,
  MAX_FOLLOW_DEPTH,
  SCOUT_TRIES_MS,
  ScreenTwo,
  ScreenTwoClasses,
  ScreenTwoReport,
  activeTabKey,
  addCardToFirstTab,
  classSelector,
  addTab,
  collectClassModules,
  collectorOwnsPanel,
  coreClassMaps,
  discoverScreenTwo,
  fiberOf,
  findTabProp,
  findTabbedPageComponents,
  forgeTabProps,
  isMemo,
  keyReport,
  resolveClassUnion,
  screenTwoClassesFrom,
  screenTwoDiagnostic,
  showTabKey,
  shownTabId,
  tabbedPagesNear,
  unwrapMemo,
  wrapMemo,
  findInsertionChildren,
  findSectionHost,
  findTabContainer,
  firstTabActive,
  gameCarriers,
  insertCard,
  isFollowable,
  isOverviewFiber,
  outlineTree,
  overviewIndex,
  pathElements,
  placementLog,
  placements,
  resolveClassModule,
  screenTwo,
  steamTabs,
  tabSwitcher,
} from "./gamePageAnchor";
import { FailureBudget, MODS_TAB_ID, MODS_TAB_TITLE, gamePagePlacement } from "./forgeRules";
import { collectorPageHandled } from "./collectorBridge";
import { getForgeSetting } from "./forgeSettings";

const ROUTE = "/library/app/:appid";
const SCOUT_KEY = "forge-screen-two-scout";
const CARD_KEY = "forge-mods-card";
const TAB_KEY = "forge-mods-tab";
/** Bounds how many component types the patch may ever wrap in a session. */
const MAX_PATCHED_TYPES = 96;
const budget = new FailureBudget();
let patch: RoutePatch | null = null;
let unloaded = false;

function noteFailure(where: string, e: unknown): void {
  const exhausted = budget.fail();
  console.error(`Forge game page: ${where} failed (${budget.count})`, e);
  if (exhausted) {
    console.error("Forge game page: switched off for this session after repeated failures");
  }
}

class ForgeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    noteFailure("section render", error);
  }

  render(): ReactNode {
    if (this.state.failed || budget.disabled || unloaded) return null;
    return this.props.children;
  }
}

// Steam game (1), demo (8) or non-Steam shortcut (1 << 30): every game in
// the library (anygame.72). Soundtracks, tools, videos: left alone. A ROM
// shortcut is drawn by The Collector and recognised by its wrapper below.
const SHORTCUT_TYPE = 1073741824;
function isGameType(appType: unknown): boolean {
  return appType === undefined || appType === 1 || appType === 8 || appType === SHORTCUT_TYPE;
}

let innerContainerClass: string | undefined;
let classLookupDone = false;

// Read once per session: the class module is fixed for a Steam build. A miss
// is logged once and the page is then found by the overview panel alone.
function innerContainer(): string | undefined {
  if (!classLookupDone) {
    classLookupDone = true;
    innerContainerClass = resolveClassModule(DFL, "appDetailsClasses", ["InnerContainer"])?.InnerContainer;
    if (!innerContainerClass) console.warn("Forge game page: no InnerContainer class on this Steam build; using the overview panel");
  }
  return innerContainerClass;
}

interface ClassState {
  two: ScreenTwoClasses;
  report: ScreenTwoReport["maps"];
  keys: ScreenTwoReport["keys"];
  core: boolean;
}
let classState: ClassState | undefined;
let classTries = 0;

// Screen two's classes (Core's CORE-UI.md: AppDetailsContainer, the tabbed
// page's TabRow, the section cards): every Steam module carrying a map's keys,
// merged (duplicates have different hashes; either may be on screen), plus
// Core's own resolved maps if Core publishes them. Kept once every map is
// found; looked up again (a few times) while one is missing.
function screenTwoState(): ClassState {
  const complete = (c: ClassState) => Object.values(c.report).every((m) => m.modules > 0 || m.source !== "none");
  if (!classState || (!complete(classState) && classTries < 5)) {
    classTries++;
    try {
      const core = coreClassMaps(globalThis);
      const { maps, report } = resolveClassUnion(collectClassModules(DFL), CLASS_MAP_SPECS, core);
      classState = { two: screenTwoClassesFrom(maps), report, keys: keyReport(maps), core: Boolean(core) };
    } catch (e) {
      noteFailure("reading Steam's class maps", e);
      classState = classState ?? { two: {}, report: {}, keys: {}, core: false };
    }
  }
  return classState;
}

function screenTwoClasses(): ScreenTwoClasses {
  return screenTwoState().two;
}

// The game the route is drawing, set by the route patch: the renders followed
// below only ever place Forge for this game, so a component Steam also uses
// elsewhere never grows a Forge tab or card there.
let activeAppId = 0;
// Pages whose scout has finished looking (the first-tab card waits for it).
const scoutDone = new Set<number>();
// Whether each game's tabbed page last showed its first tab.
const onFirstTab = new Map<number, boolean>();

// One tree patcher per Steam component type, so a type is always swapped for
// the same patched copy (a different copy would remount it on every render).
const patchers = new Map<unknown, (args: unknown[], element: any) => any>();
const originals = new WeakMap<object, unknown>();
function original(t: unknown): unknown {
  return (t && (typeof t === "object" || typeof t === "function") && originals.get(t as object)) || t;
}

// Follows `element`'s component so its render runs onPanelRender. Depth 1 is
// the overview panel itself.
function follow(element: any, depth: number, from: string = "the overview panel"): void {
  if (depth > MAX_FOLLOW_DEPTH || !isFollowable(element)) return;
  const orig = element.type;
  if (originals.has(orig)) return; // already followed in this render
  let run = patchers.get(orig);
  if (!run) {
    if (patchers.size >= MAX_PATCHED_TYPES) return;
    run = createReactTreePatcher(
      [(node: any) => node],
      function (this: any, args: any[], ret?: any) {
        return onPanelRender(depth, this, args, ret, from);
      },
      `ForgeScreenTwo${depth}`
    );
    patchers.set(orig, run);
  }
  run([], element);
  if (element.type !== orig && element.type) originals.set(element.type, orig);
}

function card(appId: number): ReactNode {
  return (
    <ForgeBoundary key={CARD_KEY}>
      <GameModsSection appId={appId} placement="card" />
    </ForgeBoundary>
  );
}

// ---- Steam's tabbed page, patched where it is defined (anygame.78) ---------

// One per mounted tabbed page (Steam's, rendered through Forge's wrapper).
interface TabbedRecord {
  /** The game whose screen two this tabbed page is (0: not confirmed). */
  app: number;
  /** Forge's tab is the one shown (selected through `opener`). */
  forgeActive: boolean;
  /** The tab Steam's own props last said was shown. */
  parentActive: unknown;
  /** Steam's own switcher from the last render. */
  parentShow?: (id: string) => void;
  /** Forge's switcher handed to the tabbed page (and the card's X). */
  opener?: (id: string) => void;
  /** Confirmation attempts made from this tabbed page's own renders. */
  tries: number;
  /** Forge's tab was in the last render. */
  added: boolean;
  /** The card ends the first tab (no section list found once the scout finished). */
  tail: boolean;
  /** `learnEpoch` when this tabbed page last drew its first tab. */
  epoch?: number;
  force?: () => void;
}

// Keyed by the props object a tabbed page rendered with: React keeps it as the
// fiber's memoizedProps, so the scout can map a fiber below it to its record.
const tabbedRecords = new WeakMap<object, TabbedRecord>();
// The scout element of the game page on screen, per app id.
const liveScouts = new Map<number, HTMLElement>();
// Every memo Forge wrapped this session (put back on unload).
const wrappedMemos = new Set<any>();
let deckyTabsWrapped = false;
let componentSearches = 0;
let lastNear = 0;
// Bumped whenever the scout learns something about screen two.
let learnEpoch = 0;

// The section list in a render: the class the scout read from the DOM, else
// every copy of AppDetailSectionList from the merged class maps.
function sectionHostMatch(): { tokens?: string[]; exact?: string } | undefined {
  if (screenTwo.sectionHost) return screenTwo.sectionHost;
  const tokens = screenTwoClasses().sectionList ?? [];
  return tokens.length ? { tokens } : undefined;
}

function buildTabbedWrapper(original: (...a: any[]) => any): (...a: any[]) => any {
  return function ForgeTabbedPage(this: any, props: any, ...rest: any[]) {
    // Hooks first, always the same ones in the same order (Steam's own hooks
    // follow inside `original`); they stay harmless after Forge unloads.
    const ref = useRef<TabbedRecord | null>(null);
    if (ref.current === null) {
      ref.current = { app: 0, forgeActive: false, parentActive: undefined, tries: 0, added: false, tail: false };
    }
    const rec = ref.current;
    const [, force] = useReducer((n: number) => n + 1, 0);
    rec.force = force;
    let next = props;
    if (!unloaded && props && typeof props === "object") {
      try {
        tabbedRecords.set(props, rec);
        next = forgeTabbedProps(props, rec) ?? props;
      } catch (e) {
        rec.added = false;
        next = props;
        noteFailure("adding the Mods tab to Steam's tabbed page", e);
      }
    }
    useLayoutEffect(() => {
      afterTabbedRender(rec);
    });
    return original.call(this, next, ...rest);
  };
}

// Steam's tabbed page props with Forge's tab (and the card in the first tab),
// for the tabbed page the scout confirmed on the game page on screen only;
// undefined (Steam's props unchanged) everywhere else.
function forgeTabbedProps(props: any, rec: TabbedRecord): any {
  rec.added = false;
  if (budget.disabled || !getForgeSetting("gamePage")) return undefined;
  const app = rec.app;
  if (!app || app !== activeAppId || !findTabProp(props)) return undefined;
  const parentActive = props[activeTabKey(props)];
  if (rec.parentActive !== parentActive) {
    rec.parentActive = parentActive;
    if (parentActive !== MODS_TAB_ID) rec.forgeActive = false;
  }
  const show = showTabKey(props);
  rec.parentShow = show ? props[show] : undefined;
  if (!rec.opener) {
    rec.opener = (id: string) => {
      if (id === MODS_TAB_ID) {
        if (!rec.forgeActive) {
          rec.forgeActive = true;
          rec.force?.();
        }
        return;
      }
      const was = rec.forgeActive;
      rec.forgeActive = false;
      try {
        rec.parentShow?.(id);
      } finally {
        if (was) rec.force?.();
      }
    };
  }
  const shape = findTabProp(props)!;
  const firstId = props[shape.prop][0]?.[shape.idKey];
  const firstShown = !rec.forgeActive && shownTabId(props) === firstId;
  const next = forgeTabProps(props, {
    id: MODS_TAB_ID,
    title: MODS_TAB_TITLE,
    content: (
      <ForgeBoundary key={TAB_KEY}>
        <GameModsSection appId={app} placement="tab" />
      </ForgeBoundary>
    ),
    forgeActive: rec.forgeActive,
    onShow: rec.opener,
    firstContent: (content) => firstTabContent(content, app, rec, firstShown),
  });
  rec.added = Boolean(next);
  return next;
}

// The first tab's content with the card: among the section cards when their
// list is in this content (found by the merged class maps or the class the
// scout read), else along the scout's path inside the content; else, once the
// scout has finished, at the end. Always wrapped the same way (content, then
// the card or nothing) so Steam's content keeps its place and never remounts.
function firstTabContent(content: unknown, app: number, rec: TabbedRecord, shown: boolean): unknown {
  try {
    // Something new was learned since this tabbed page last drew: hand Steam
    // a fresh copy of the content element, or React would skip re-rendering
    // it (same element) and never reach the cards along the new path.
    if (rec.epoch !== learnEpoch) {
      if (rec.epoch !== undefined && isValidElement(content)) content = cloneElement(content);
      rec.epoch = learnEpoch;
    }
    const host = findSectionHost(content, sectionHostMatch());
    if (host) {
      if (insertCard(host, card(app), CARD_KEY) >= 0) placementLog.note("card among Steam's section cards (first tab)");
    } else if (isFollowable(content)) {
      // Followed from the first render, so learning the path later never
      // swaps the content's type (no remount).
      follow(content, 1, "the first tab's content");
    }
    if (!rec.tail && shown && scoutDone.has(app) && !screenTwo.sectionHost && !host) {
      rec.tail = true;
      placementLog.note("card at the end of Steam's first tab (no section list found)");
    }
  } catch (e) {
    noteFailure("placing the card in the first tab", e);
  }
  return (
    <>
      {content}
      {rec.tail ? card(app) : null}
    </>
  );
}

function afterTabbedRender(rec: TabbedRecord): void {
  if (unloaded) return;
  try {
    if (rec.app && rec.app === activeAppId) {
      if (rec.added) {
        steamTabs.note(rec.app, rec.opener);
        placementLog.note("tab in Steam's tab row (Steam's tabbed page, patched where it is defined)");
      }
      return;
    }
    if (!activeAppId || !liveScouts.has(activeAppId) || rec.tries >= 3) return;
    rec.tries++;
    confirmNear(activeAppId);
  } catch (e) {
    noteFailure("confirming Steam's tabbed page", e);
  }
}

// Tells the first tabbed page in the fibers below the game page's scout that
// it is that page's screen two (a tabbed page nested inside a tab is never the
// first: the fiber walk is depth first). Returns how many were seen.
function confirmNear(app: number): number {
  const el = liveScouts.get(app);
  const f = fiberOf(el);
  if (!f) return 0;
  const found = tabbedPagesNear(f, (props) => tabbedRecords.get(props as object));
  lastNear = found.length;
  const first = found[0];
  if (first && first.app !== app) {
    first.app = app;
    first.tries = 0;
    first.tail = false;
    first.force?.();
  }
  return found.length;
}

function wrapTabbed(memo: any): boolean {
  if (wrappedMemos.has(memo) || !isMemo(memo)) return false;
  if (!wrapMemo(memo, buildTabbedWrapper)) return false;
  wrappedMemos.add(memo);
  return true;
}

// Finds and wraps Steam's tabbed page component(s): every copy of the module
// @decky/ui finds Tabs in, plus Tabs itself. Bounded to a few searches a
// session (Steam may load a chunk late).
function patchTabbedPages(): number {
  if (componentSearches >= 3 || (wrappedMemos.size && componentSearches)) return wrappedMemos.size;
  componentSearches++;
  try {
    const ui: any = DFL;
    const modules: any[] = [];
    const take = (m: any) => {
      if (m && (typeof m === "object" || typeof m === "function")) modules.push(m);
      return undefined;
    };
    try {
      if (typeof ui.findModuleChild === "function") ui.findModuleChild(take);
    } catch {
      // keep what was collected
    }
    try {
      const scopes = ui.moduleScopes;
      if (scopes && typeof scopes.values === "function") for (const scope of scopes.values()) take(scope);
    } catch {
      // Decky 3 has no module scopes
    }
    let tabs: unknown;
    try {
      tabs = ui.Tabs;
    } catch {
      tabs = undefined;
    }
    for (const memo of findTabbedPageComponents(modules, [tabs])) {
      if (wrapTabbed(memo) && memo === tabs) deckyTabsWrapped = true;
    }
  } catch (e) {
    noteFailure("patching Steam's tabbed page", e);
  }
  return wrappedMemos.size;
}

// One render below the overview panel: Forge's tab goes into Steam's tabbed
// page when this render holds it, the card among the section cards when this
// render holds their list; then the game carriers and the discovered path's
// components here are followed one level further. A render with neither is
// not an error.
function onPanelRender(depth: number, self: any, args: any[], ret: any, from = "the overview panel"): any {
  if (unloaded || budget.disabled || !getForgeSetting("gamePage")) return ret;
  try {
    const props = args?.[0] ?? self?.props;
    const own = Number(props?.overview?.appid) || 0;
    const appId = own || activeAppId;
    if (!appId || appId !== activeAppId) return ret;
    if (depth === 1 && from === "the overview panel") placementLog.rememberOutline(outlineTree(ret));

    let tabs: ReturnType<typeof findTabContainer>;
    try {
      tabs = findTabContainer(ret);
      if (tabs) {
        addTab(
          tabs,
          MODS_TAB_ID,
          MODS_TAB_TITLE,
          <ForgeBoundary key={TAB_KEY}>
            <GameModsSection appId={appId} placement="tab" />
          </ForgeBoundary>
        );
        steamTabs.note(appId, tabSwitcher(tabs));
        onFirstTab.set(appId, firstTabActive(tabs));
        placementLog.note(`tab in Steam's tab row (${depth} below ${from})`);
      }
    } catch (e) {
      noteFailure(`adding the Mods tab (depth ${depth})`, e);
    }

    try {
      const host = findSectionHost(ret, sectionHostMatch());
      const where = gamePagePlacement({
        overviewFound: true,
        tabContainer: Boolean(tabs) || steamTabs.injected(appId),
        sectionCards: Boolean(host || screenTwo.sectionHost),
        scoutDone: scoutDone.has(appId),
      });
      if (host && where.card === "sections" && onFirstTab.get(appId) !== false) {
        if (insertCard(host, card(appId), CARD_KEY) >= 0) {
          placementLog.note(`card among Steam's section cards (${depth} below ${from})`);
        }
      } else if (tabs && where.card === "first-tab") {
        if (addCardToFirstTab(tabs, CARD_KEY, (content) => (
          <>
            {content}
            {card(appId)}
          </>
        ))) {
          placementLog.note("card at the end of Steam's first tab (no section list found)");
        }
      }
    } catch (e) {
      noteFailure(`placing the card (depth ${depth})`, e);
    }

    const next = new Set<any>(pathElements(ret, screenTwo.types));
    if (depth < CARRIER_DEPTH) for (const c of gameCarriers(ret)) next.add(c);
    for (const el of next) follow(el, depth + 1, from);
  } catch (e) {
    noteFailure(`placing Forge on screen two (depth ${depth})`, e);
  }
  return ret;
}

// After the scout learns a path, Steam has to render the panel again for it
// to be followed. Best effort: the nearest class component from screen two up
// to (and just above) the overview panel is told to update. Function
// components cannot be; then the next render (Steam re-renders the page as
// its data loads) or the next game page picks the path up.
function nudge(fromEl: any): boolean {
  try {
    let f = fiberOf(fromEl);
    let pastPanel = 0;
    for (let i = 0; f && i < 160 && pastPanel < 12; i++, f = f.return) {
      if (pastPanel) pastPanel++;
      if (isOverviewFiber(f)) pastPanel = 1;
      const inst = f.stateNode;
      if (inst && typeof inst.forceUpdate === "function" && typeof inst.render === "function") {
        inst.forceUpdate();
        return true;
      }
    }
  } catch (e) {
    noteFailure("asking Steam to draw screen two again", e);
  }
  return false;
}

// The diagnostic report for the "nothing shown" line.
function report(scout: ScreenTwo | undefined, scoutEl: any): ScreenTwoReport {
  const state = screenTwoState();
  return {
    maps: state.report,
    keys: state.keys,
    coreGlobal: state.core,
    patched: wrappedMemos.size,
    deckyTabs: deckyTabsWrapped,
    scoutFibers: Boolean(fiberOf(scoutEl)),
    wrappedNear: lastNear,
    scout,
  };
}

// The scout: an invisible element (display: none, no focus, no size) in
// InnerContainer. It marks the game page on screen (for the tabbed page
// wrapper, from the first commit), and after the page mounts it looks for
// screen two in the DOM, which teaches the way to the section cards (and, for
// a Steam build whose tabbed page is not a memo, .77's way to the tabs).
function ScreenTwoScout({ appId }: { appId: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    activeAppId = appId;
    liveScouts.set(appId, el);
    try {
      confirmNear(appId);
    } catch (e) {
      noteFailure("confirming Steam's tabbed page", e);
    }
    return () => {
      if (liveScouts.get(appId) === el) liveScouts.delete(appId);
      if (activeAppId === appId) activeAppId = 0;
    };
  }, [appId]);
  useEffect(() => {
    let alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let last: ScreenTwo | undefined;
    const placed = () => steamTabs.injected(appId) && placements.has(appId);
    const look = (final: boolean) => {
      if (!alive || unloaded || budget.disabled) return;
      try {
        const root = ref.current?.parentElement;
        if (!root) return;
        if (!placed()) {
          if (!wrappedMemos.size) patchTabbedPages();
          confirmNear(appId);
          last = discoverScreenTwo(root, screenTwoClasses(), original);
          // The tabbed page above the tab row: wrapped now when the load-time
          // search missed it (shown from the next game page opened).
          if (last.tabbedType && isMemo(last.tabbedType) && wrapTabbed(last.tabbedType)) {
            placementLog.note("tabbed page found from the tab row and patched (Mods from the next game page)");
          }
          if (screenTwo.learn(last)) {
            learnEpoch++;
            for (const rec of confirmedRecords(appId)) rec.force?.();
            const told = nudge(root.querySelector?.(classSelectorOf(screenTwoClasses().container)) ?? root);
            placementLog.note(
              `path to screen two learned${told ? "" : " (Steam not asked to redraw: shown from its next render)"}`
            );
          }
        }
        if (final) {
          scoutDone.add(appId);
          // The tab is in but no section list was found: the card can now end
          // the first tab, from the next render.
          if (steamTabs.injected(appId) && !placements.has(appId)) {
            for (const rec of confirmedRecords(appId)) rec.force?.();
            nudge(root);
          }
          timers.push(
            setTimeout(() => {
              if (!alive) return;
              if (!steamTabs.injected(appId) && !placements.has(appId)) {
                placementLog.noteNothing(screenTwoDiagnostic(report(last, ref.current)), last?.outline ?? []);
              }
            }, 1000)
          );
        }
      } catch (e) {
        noteFailure("looking for screen two", e);
      }
    };
    SCOUT_TRIES_MS.forEach((ms, i) => timers.push(setTimeout(() => look(i === SCOUT_TRIES_MS.length - 1), ms)));
    return () => {
      alive = false;
      for (const t of timers) clearTimeout(t);
    };
  }, [appId]);
  return <span ref={ref} data-forge-scout="" aria-hidden="true" style={{ display: "none" }} />;
}

function classSelectorOf(values: string[] | undefined): string {
  return classSelector(values) ?? "[data-forge-none]";
}

// The tabbed page records confirmed for a game, found again through the fibers.
function confirmedRecords(app: number): TabbedRecord[] {
  const f = fiberOf(liveScouts.get(app));
  if (!f) return [];
  return tabbedPagesNear(f, (props) => tabbedRecords.get(props as object)).filter((r) => r.app === app);
}

export function registerGamePagePatch(): void {
  if (patch) return;
  unloaded = false;
  // Steam's tabbed page component, wrapped before any game page opens (the
  // first one after Steam starts included).
  if (getForgeSetting("gamePage")) patchTabbedPages();
  try {
    patch = routerHook.addPatch(ROUTE, (tree: any) => {
      if (unloaded || budget.disabled) return tree;
      try {
        const routeProps = findInReactTree(tree, (x: any) => typeof x?.renderFunc === "function");
        if (!routeProps) return tree;
        let appId = 0;
        let appType: unknown;
        const handler = createReactTreePatcher(
          [
            (node: any) => {
              try {
                const children = findInReactTree(node, (x: any) => x?.props?.children?.props?.overview)
                  ?.props?.children;
                const overview = children?.props?.overview;
                appId = Number(overview?.appid) || 0;
                appType = overview?.app_type;
                return children ?? null;
              } catch (e) {
                noteFailure("finding the overview", e);
                return null;
              }
            },
          ],
          (_args: unknown[], ret?: any) => {
            if (unloaded || budget.disabled || !getForgeSetting("gamePage")) return ret;
            try {
              // The overview inside this render beats the one the step saw:
              // the patched node can re-render on its own.
              const own = findInReactTree(ret, (x: any) => x?.props?.overview?.appid)?.props?.overview;
              if (own) {
                appId = Number(own.appid) || appId;
                appType = own.app_type ?? appType;
              }
              if (!appId || !isGameType(appType)) {
                activeAppId = 0;
                return ret;
              }
              const children = findInsertionChildren(ret, findInReactTree, innerContainer());
              if (!Array.isArray(children)) return ret;
              // A RomM shortcut drawn by The Collector: its wrapper replaces
              // the overview panel, and ROMs rarely have Nexus mods.
              if (collectorOwnsPanel(children)) {
                activeAppId = 0;
                placementLog.note(
                  collectorPageHandled(globalThis as any)
                    ? "on The Collector's page (its tab and card, through window.__eternalGamePage)"
                    : "left out (The Collector draws this page and has no game-page API)"
                );
                return ret;
              }
              // A fresh page render: the tab container is looked for again.
              if (activeAppId !== appId) {
                steamTabs.clear(appId);
                onFirstTab.delete(appId);
                scoutDone.delete(appId);
              }
              activeAppId = appId;
              const at = overviewIndex(children);
              if (at < 0) return ret;
              // Screen two: follow the overview panel's own render (cached
              // per component type), and from there the game carriers and the
              // scout's path, down to Steam's tabbed page and section list.
              // Done on every render: the panel element is new each time.
              try {
                follow(children[at].props.children, 1);
              } catch (e) {
                noteFailure("following the overview panel", e);
              }
              if (children.some((c: any) => c?.key === SCOUT_KEY)) return ret;
              // The scout draws nothing (display: none): nothing on screen one.
              children.splice(at, 0, <ScreenTwoScout key={SCOUT_KEY} appId={appId} />);
            } catch (e) {
              noteFailure("inserting the scout", e);
            }
            return ret;
          },
          "ForgeGameMods"
        );
        afterPatch(routeProps, "renderFunc", handler);
      } catch (e) {
        noteFailure("patching the route", e);
      }
      return tree;
    });
  } catch (e) {
    noteFailure("registering the patch", e);
    patch = null;
  }
}

export function unregisterGamePagePatch(): void {
  unloaded = true;
  for (const memo of wrappedMemos) unwrapMemo(memo);
  wrappedMemos.clear();
  componentSearches = 0;
  deckyTabsWrapped = false;
  liveScouts.clear();
  if (!patch) return;
  try {
    routerHook.removePatch(ROUTE, patch);
  } catch (e) {
    console.error("Forge game page: unpatch failed", e);
  }
  patch = null;
}
