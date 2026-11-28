// Puts Forge's Mods tab and Overview card on Steam's game page, the way
// ProtonDB Badges and HLTB for Deck add theirs: a routerHook patch on
// /library/app/:appid.
//
// Where it goes (anygame.77): screen two of Core's game view, never screen
// one. Core 3.3.9 makes screen one the hero art, the logo and a transparent
// play bar, and puts Steam's tab row and section cards one press down
// (Core's docs/eternal/CORE-UI.md, "For Forge"). So Forge adds a "Mods" tab to
// Steam's tabbed page (its `tabs` prop, a new array) and its Overview card
// among the section cards (`AppDetailSectionList`). Order:
// forgeRules.gamePagePlacement. When neither is found, NOTHING is drawn and
// the page outline is logged once: there is no row above Play any more.
//
// How it gets there: the patch follows Steam's overview panel (InnerContainer's
// child, recognised by its props) and, from its renders, two kinds of
// components: those handed the game (`overview` / `details`, within
// CARRIER_DEPTH levels, the anygame.71 search) and those on the path the scout
// discovered. The scout is an invisible element in InnerContainer: after the
// page mounts it finds screen two in the DOM by Core's class maps and climbs
// React's fibers from there to the overview panel, naming every component on
// the way (gamePageAnchor.discoverScreenTwo). The path is kept for the session,
// so later pages are placed on their first render. Non-Steam shortcuts get the
// same; a page The Collector draws (a ROM) is left to The Collector, which
// hosts Forge's tab and card through window.__eternalGamePage
// (collectorBridge.ts).
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
import { Component, ErrorInfo, ReactNode, useEffect, useRef } from "react";

import { GameModsSection } from "./GameModsSection";
import {
  CARRIER_DEPTH,
  MAX_FOLLOW_DEPTH,
  SCOUT_TRIES_MS,
  ScreenTwo,
  ScreenTwoClasses,
  addCardToFirstTab,
  addTab,
  collectorOwnsPanel,
  discoverScreenTwo,
  fiberOf,
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

let twoClasses: ScreenTwoClasses | undefined;

// Screen two's classes (Core's CORE-UI.md: AppDetailsContainer, the tabbed
// page's TabRow, the section cards), read once per session.
function screenTwoClasses(): ScreenTwoClasses {
  if (!twoClasses) {
    const details = resolveClassModule(DFL, "basicAppDetailsSectionStylerClasses", ["AppDetailsRoot", "AppDetailsContainer"]);
    const tabbed = resolveClassModule(DFL, "gamepadTabbedPageClasses", ["GamepadTabbedPage", "TabRow"]);
    const section = resolveClassModule(DFL, "appDetailsSectionClasses", ["AppDetailsSection", "AppDetailsSectionContainer"]);
    twoClasses = {
      container: details?.AppDetailsContainer,
      sectionList: details?.AppDetailSectionList,
      tabRow: [tabbed?.TabRow, tabbed?.TabRowTabs].filter((c): c is string => Boolean(c)),
      section: [section?.AppDetailsSection, section?.AppDetailsSectionContainer].filter((c): c is string => Boolean(c)),
    };
    const missing = Object.entries(twoClasses)
      .filter(([, v]) => !v || (Array.isArray(v) && !v.length))
      .map(([k]) => k);
    if (missing.length) console.warn(`Forge game page: screen two classes missing on this Steam build: ${missing.join(", ")}`);
  }
  return twoClasses;
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
function follow(element: any, depth: number): void {
  if (depth > MAX_FOLLOW_DEPTH || !isFollowable(element)) return;
  const orig = element.type;
  if (originals.has(orig)) return; // already followed in this render
  let run = patchers.get(orig);
  if (!run) {
    if (patchers.size >= MAX_PATCHED_TYPES) return;
    run = createReactTreePatcher(
      [(node: any) => node],
      function (this: any, args: any[], ret?: any) {
        return onPanelRender(depth, this, args, ret);
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

// One render below the overview panel: Forge's tab goes into Steam's tabbed
// page when this render holds it, the card among the section cards when this
// render holds their list; then the game carriers and the discovered path's
// components here are followed one level further. A render with neither is
// not an error.
function onPanelRender(depth: number, self: any, args: any[], ret: any): any {
  if (unloaded || budget.disabled || !getForgeSetting("gamePage")) return ret;
  try {
    const props = args?.[0] ?? self?.props;
    const own = Number(props?.overview?.appid) || 0;
    const appId = own || activeAppId;
    if (!appId || appId !== activeAppId) return ret;
    if (depth === 1) placementLog.rememberOutline(outlineTree(ret));

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
        placementLog.note(`tab in Steam's tab row (${depth} below the overview panel)`);
      }
    } catch (e) {
      noteFailure(`adding the Mods tab (depth ${depth})`, e);
    }

    try {
      const host = findSectionHost(ret, screenTwo.sectionHost);
      const where = gamePagePlacement({
        overviewFound: true,
        tabContainer: Boolean(tabs) || steamTabs.injected(appId),
        sectionCards: Boolean(screenTwo.sectionHost),
        scoutDone: scoutDone.has(appId),
      });
      if (host && where.card === "sections" && onFirstTab.get(appId) !== false) {
        if (insertCard(host, card(appId), CARD_KEY) >= 0) {
          placementLog.note(`card among Steam's section cards (${depth} below the overview panel)`);
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
    for (const el of next) follow(el, depth + 1);
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

// The scout: an invisible element (display: none, no focus, no size) in
// InnerContainer that looks for screen two after the page mounts.
function ScreenTwoScout({ appId }: { appId: number }) {
  const ref = useRef<HTMLSpanElement>(null);
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
          last = discoverScreenTwo(root, screenTwoClasses(), original);
          if (screenTwo.learn(last)) {
            const told = nudge(root.querySelector?.(`.${screenTwoClasses().container}`) ?? root);
            placementLog.note(
              `path to screen two learned${told ? "" : " (Steam not asked to redraw: shown from its next render)"}`
            );
          }
        }
        if (final) {
          scoutDone.add(appId);
          // The tab is in but no section list was found: the card can now end
          // the first tab, from the next render.
          if (steamTabs.injected(appId) && !placements.has(appId)) nudge(root);
          timers.push(
            setTimeout(() => {
              if (!alive) return;
              if (!steamTabs.injected(appId) && !placements.has(appId)) placementLog.noteNothing(last?.outline ?? []);
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

export function registerGamePagePatch(): void {
  if (patch) return;
  unloaded = false;
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
  if (!patch) return;
  try {
    routerHook.removePatch(ROUTE, patch);
  } catch (e) {
    console.error("Forge game page: unpatch failed", e);
  }
  patch = null;
}
