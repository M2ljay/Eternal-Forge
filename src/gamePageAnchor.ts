// Where Forge's Mods section goes on Steam's game page, found in a way that
// works under both Decky loaders. No imports, so the node tests compile it
// standalone (pnpm run test:anchor).
//
// @decky/ui is supplied by the loader at runtime: 4.x under Decky 3.3.1
// (webpack Steam client) and 5.x under Decky 4.0 (ES-module Steam client,
// nearly every CSS class renamed). 5.x pins class names per Steam build, so a
// class can be missing or stale; the overview panel's props are not renamed.

export type TreeFinder = (node: any, filter: (x: any) => boolean) => any;
type ModuleFinder = (filter: (value: unknown) => boolean) => unknown;

/** Steam's own overview panel among InnerContainer's children, by the
 * props it is rendered with (the same shape HLTB for Deck keys on). */
export function overviewIndex(children: any[]): number {
  return children.findIndex(
    (c: any) =>
      c?.props?.children?.props?.overview !== undefined &&
      c?.props?.children?.props?.details !== undefined &&
      c?.props?.children?.props?.bFastRender !== undefined
  );
}

/** InnerContainer's children array: by its class when one is known, else as
 * the array that holds the overview panel. Undefined when neither is found. */
export function findInsertionChildren(
  tree: any,
  find: TreeFinder,
  innerContainerClass?: string
): any[] | undefined {
  const hasChildren = (x: any) => Array.isArray(x?.props?.children);
  if (innerContainerClass) {
    const byClass = find(tree, (x: any) => hasChildren(x) && x?.props?.className?.includes?.(innerContainerClass));
    if (byClass && overviewIndex(byClass.props.children) >= 0) return byClass.props.children;
  }
  const byPanel = find(tree, (x: any) => hasChildren(x) && overviewIndex(x.props.children) >= 0);
  return byPanel?.props?.children;
}

function finder(ui: any, name: string): ModuleFinder | undefined {
  try {
    const value = ui?.[name];
    return typeof value === "function" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A @decky/ui class module: the named export, else the first module carrying
 * every key via findClassModule, else via findVar (module scope, 5.x only).
 * Never throws; undefined when nothing matches. */
export function resolveClassModule(ui: any, name: string, keys: string[]): Record<string, string> | undefined {
  const matches = (value: unknown): boolean =>
    typeof value === "object" &&
    value !== null &&
    keys.every((key) => typeof (value as Record<string, unknown>)[key] === "string");
  try {
    const named = ui?.[name];
    if (matches(named)) return named;
  } catch {
    // fall through to the finders
  }
  for (const finderName of ["findClassModule", "findVar"]) {
    const find = finder(ui, finderName);
    if (!find) continue;
    try {
      const found = find(matches);
      if (matches(found)) return found as Record<string, string>;
    } catch {
      // a probe can throw on a module with hostile getters; try the next one
    }
  }
  return undefined;
}

// ---- Below the Play bar ----------------------------------------------------
// InnerContainer holds Steam's header (hero) and the overview panel, and the
// overview panel draws the Play bar, the stats and the tabs itself. So the
// section can only sit under Play from inside that panel's own render: the
// patch follows the panel's component one level further and puts the section
// right after the play section there. When that render has no play section
// (an unknown class, a Steam build that draws it one level deeper), the
// section falls back to a single line above the panel.

/** True when the element carries one of `names` as a whole class. */
export function hasClass(node: any, names: string[]): boolean {
  const cls = node?.props?.className;
  if (typeof cls !== "string" || !cls) return false;
  const tokens = cls.split(/\s+/);
  return names.some((name) => tokens.includes(name));
}

export interface Slot {
  children: any[];
  /** Where to splice: directly after the play section. */
  index: number;
}

/** The children array holding Steam's play section, and the index right after
 * it. `classNames` are the play section's classes as the loader maps them
 * (empty or missing ones are ignored). Undefined when nothing matches. */
export function findPlaySectionSlot(tree: any, find: TreeFinder, classNames: (string | undefined)[]): Slot | undefined {
  const names = classNames.filter((n): n is string => typeof n === "string" && n.length > 0);
  if (!names.length || !tree) return undefined;
  const holds = (x: any) => Array.isArray(x?.props?.children) && x.props.children.some((c: any) => hasClass(c, names));
  const parent = find(tree, holds);
  if (!parent) return undefined;
  const children: any[] = parent.props.children;
  const at = children.findIndex((c: any) => hasClass(c, names));
  return at < 0 ? undefined : { children, index: at + 1 };
}

/** Puts `element` after the play section unless an element with `key` is
 * already in that array. Returns where it went, or -1 when nothing was done. */
export function insertAfterPlay(tree: any, find: TreeFinder, classNames: (string | undefined)[], element: any, key: string): number {
  const slot = findPlaySectionSlot(tree, find, classNames);
  if (!slot) return -1;
  if (slot.children.some((c: any) => c?.key === key)) return -1;
  slot.children.splice(slot.index, 0, element);
  return slot.index;
}

/** Which copies of the section are on screen. The one below Play registers
 * itself while mounted; the one-line copy above the panel shows only when no
 * copy below Play is mounted for that game, and only after a short grace
 * period, so a page where both anchors work never flashes the line above. */
export const ABOVE_GRACE_MS = 600;

export function aboveFallbackShown(belowMounted: boolean, graceElapsed: boolean): boolean {
  return !belowMounted && graceElapsed;
}

export class PlacementRegistry {
  private mounted = new Map<number, number>();
  private listeners = new Set<() => void>();

  /** Registers a copy below Play; call the returned function on unmount. */
  mountBelow(appId: number): () => void {
    this.mounted.set(appId, (this.mounted.get(appId) ?? 0) + 1);
    this.emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.mounted.get(appId) ?? 1) - 1;
      if (n > 0) this.mounted.set(appId, n);
      else this.mounted.delete(appId);
      this.emit();
    };
  }

  hasBelow(appId: number): boolean {
    return (this.mounted.get(appId) ?? 0) > 0;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // one listener's failure must not stop the others
      }
    }
  }
}

/** The one registry the game page uses (GameModsSection reads and writes it). */
export const placements = new PlacementRegistry();
