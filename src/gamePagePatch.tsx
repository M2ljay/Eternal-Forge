// Puts Forge's Mods section on Steam's game page, the way ProtonDB Badges
// and HLTB for Deck add theirs: a routerHook patch on /library/app/:appid.
//
// Where it goes: directly UNDER Steam's Play bar, so the hero is never
// covered and Play keeps the page's first focus. Steam's overview panel
// draws the Play bar and the tabs itself, so the patch follows that panel's
// component one level further and splices the section in after the play
// section of its render (found by class: basicAppDetailsSectionStylerClasses
// .PlaySection, else playSectionClasses.Container).
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
  findInsertionChildren,
  insertAfterPlay,
  overviewIndex,
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
let playMissLogged = false;

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

// The overview panel's own render: put the section after its play section.
// A render without one is not an error (Steam draws some states without a
// Play bar); the one-line copy above covers it.
const belowPlay = createReactTreePatcher(
  [(wrapper: any) => (wrapper?.props?.children?.props?.overview ? wrapper.props.children : null)],
  function (this: any, args: any[], ret?: any) {
    if (unloaded || budget.disabled || !getForgeSetting("gamePage")) return ret;
    try {
      const overview = args?.[0]?.overview ?? this?.props?.overview;
      const appId = Number(overview?.appid) || 0;
      if (!appId || !isGameType(overview?.app_type)) return ret;
      const at = insertAfterPlay(
        ret,
        findInReactTree,
        playSectionClassNames(),
        <ForgeBoundary key={BELOW_KEY}>
          <GameModsSection appId={appId} placement="below" />
        </ForgeBoundary>,
        BELOW_KEY
      );
      if (at < 0 && !playMissLogged && !findInReactTree(ret, (x: any) => x?.key === BELOW_KEY)) {
        playMissLogged = true;
        console.warn("Forge game page: no play section in the overview panel; showing the one-line section above it");
      }
    } catch (e) {
      noteFailure("placing the section under Play", e);
    }
    return ret;
  },
  "ForgeGameModsBelowPlay"
);

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
              if (!appId || !isGameType(appType)) return ret;
              const children = findInsertionChildren(ret, findInReactTree, innerContainer());
              if (!Array.isArray(children)) return ret;
              if (children.some((c: any) => c?.key === KEY)) return ret;
              const at = overviewIndex(children);
              if (at < 0) return ret;
              // Under Play: patch the overview panel's own render (cached per
              // component type by the tree patcher). Guarded on its own so a
              // failure there still leaves the line above.
              try {
                belowPlay([], children[at]);
              } catch (e) {
                noteFailure("following the overview panel", e);
              }
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
