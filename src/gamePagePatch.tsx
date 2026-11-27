// Puts Forge's Mods section on Steam's game page, the way ProtonDB Badges
// and HLTB for Deck add theirs: a routerHook patch on /library/app/:appid.
//
// Where it goes: directly UNDER Steam's Play bar, so the hero is never
// covered and Play keeps the page's first focus. Steam's overview panel
// draws the Play bar and the tabs itself, through inner components of its
// own (The Collector's TV logs prove the panel's place: InnerContainer's
// children, recognised by its props; its inner render is not seen there,
// because The Collector replaces the whole panel). So the patch follows the
// panel's component, and every component it hands the game to (`overview` /
// `details` props), up to PLAY_SEARCH_DEPTH levels, and splices the section
// in after the play section of the first render that holds it (found by
// class: basicAppDetailsSectionStylerClasses.PlaySection, else
// playSectionClasses.Container). The console says once which path was used.
//
// The old anchor stays as the fallback: a one-line copy in the app details
// InnerContainer, right before the overview panel. It renders nothing while
// the copy under Play is mounted, so it only shows when Play's section could
// not be found (gamePageAnchor.ts, PlacementRegistry).
//
// Fail-safe by construction:
// - every step is inside try/catch, and a failure returns Steam's tree
//   exactly as it came in;
// - the section renders inside an error boundary that renders nothing on
//   error;
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
import { Component, ErrorInfo, ReactNode } from "react";

import { GameModsSection } from "./GameModsSection";
import {
  PLAY_SEARCH_DEPTH,
  collectorOwnsPanel,
  findInsertionChildren,
  gameCarriers,
  isFollowable,
  locatePlaySection,
  outlineTree,
  overviewIndex,
  placementLog,
  resolveClassModule,
} from "./gamePageAnchor";
import { FailureBudget } from "./forgeRules";
import { getForgeSetting } from "./forgeSettings";

const ROUTE = "/library/app/:appid";
const KEY = "forge-mods-section";
const BELOW_KEY = "forge-mods-below-play";
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

// Steam game (1) or demo (8). Shortcuts, soundtracks, tools: left alone.
function isGameType(appType: unknown): boolean {
  return appType === undefined || appType === 1 || appType === 8;
}

let innerContainerClass: string | undefined;
let classLookupDone = false;

// Read once per session: the class module is fixed for a Steam build. A miss
// is logged once and the section is then placed by the overview panel alone.
function innerContainer(): string | undefined {
  if (!classLookupDone) {
    classLookupDone = true;
    innerContainerClass = resolveClassModule(DFL, "appDetailsClasses", ["InnerContainer"])?.InnerContainer;
    if (!innerContainerClass) console.warn("Forge game page: no InnerContainer class on this Steam build; using the overview panel");
  }
  return innerContainerClass;
}

let playClasses: (string | undefined)[] = [];
let playLookupDone = false;

// The play section's classes, read once per session. Under Decky 4.0 either
// can be missing or stale; then nothing matches and the line above is used.
function playSectionClassNames(): (string | undefined)[] {
  if (!playLookupDone) {
    playLookupDone = true;
    playClasses = [
      resolveClassModule(DFL, "basicAppDetailsSectionStylerClasses", ["PlaySection", "AppDetailsRoot"])?.PlaySection,
      resolveClassModule(DFL, "playSectionClasses", ["PlayBarDetailLabel", "Container"])?.Container,
    ];
    if (!playClasses.some(Boolean)) console.warn("Forge game page: no play section class on this Steam build; the section stays above");
  }
  return playClasses;
}

// The game the route is drawing, set by the route patch: the renders followed
// below only ever place the section for this game, so a component Steam also
// uses elsewhere never grows a Forge row there.
let activeAppId = 0;

const levels: Array<(args: unknown[], tree: any) => any> = [];

// Follows `element`'s component (cached per type, one patcher per level) so
// its render runs onPanelRender. Level 1 is the overview panel itself.
function follow(level: number, element: any): void {
  if (level > PLAY_SEARCH_DEPTH || !isFollowable(element)) return;
  if (!levels[level]) {
    levels[level] = createReactTreePatcher(
      [(node: any) => node],
      function (this: any, args: any[], ret?: any) {
        return onPanelRender(level, this, args, ret);
      },
      `ForgeGameModsBelowPlay${level}`
    );
  }
  levels[level]([], element);
}

// One render below the overview panel: the section goes right after the play
// section when this render holds it; otherwise every component here that is
// handed the game is followed one level further. A render without a play
// section is not an error (Steam draws some states without a Play bar); the
// one-line copy above covers it.
function onPanelRender(level: number, self: any, args: any[], ret: any): any {
  if (unloaded || budget.disabled || !getForgeSetting("gamePage")) return ret;
  try {
    const props = args?.[0] ?? self?.props;
    const own = Number(props?.overview?.appid) || 0;
    const appId = own || activeAppId;
    if (!appId || appId !== activeAppId) return ret;
    const names = playSectionClassNames();
    const match = locatePlaySection(ret, findInReactTree, names);
    if (match) {
      const section = (
        <ForgeBoundary key={BELOW_KEY}>
          <GameModsSection appId={appId} placement="below" />
        </ForgeBoundary>
      );
      if (match.kind === "slot") {
        if (!match.slot.children.some((c: any) => c?.key === BELOW_KEY)) {
          match.slot.children.splice(match.slot.index, 0, section);
        }
        placementLog.note(`under Play (level ${level} below the overview panel, after the play section)`);
        return ret;
      }
      // The play section is this component's own root: draw the section
      // beside it, never inside it (it may be a sticky flex row).
      placementLog.note(`under Play (level ${level} below the overview panel, beside the play section's render)`);
      return (
        <>
          {ret}
          {section}
        </>
      );
    }
    if (level === 1) placementLog.rememberOutline(outlineTree(ret));
    if (level < PLAY_SEARCH_DEPTH) {
      for (const carrier of gameCarriers(ret)) follow(level + 1, carrier);
    }
  } catch (e) {
    noteFailure(`placing the section under Play (level ${level})`, e);
  }
  return ret;
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
                placementLog.note("left out (The Collector draws this page)");
                return ret;
              }
              activeAppId = appId;
              const at = overviewIndex(children);
              if (at < 0) return ret;
              // Under Play: follow the overview panel's own render (cached
              // per component type by the tree patcher), and the components
              // it hands the game to, down to the play section. Guarded on
              // its own so a failure there still leaves the line above. Done
              // on every render: the panel element is new each time.
              try {
                follow(1, children[at].props.children);
              } catch (e) {
                noteFailure("following the overview panel", e);
              }
              if (children.some((c: any) => c?.key === KEY)) return ret;
              // Above: a single line, shown only when the copy under Play is
              // not mounted.
              children.splice(
                at,
                0,
                <ForgeBoundary key={KEY}>
                  <GameModsSection appId={appId} placement="above" />
                </ForgeBoundary>
              );
            } catch (e) {
              noteFailure("inserting the section", e);
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
