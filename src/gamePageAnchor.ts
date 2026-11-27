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
