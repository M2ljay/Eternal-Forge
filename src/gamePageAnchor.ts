// Where Forge's Mods tab and Overview card go on Steam's game page (screen
// two of Core's game view), found in a way that works under both Decky
// loaders. No imports, so the node tests compile it standalone
// (pnpm run test:anchor).
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

/** True when The Collector (eternal-romm) has replaced the overview panel
 * with its own wrapper (a RomM shortcut): Forge leaves that page alone. */
export function collectorOwnsPanel(children: any[]): boolean {
  return children.some((c: any) => c?.key === "romm-play-section" || c?.props?.["data-romm"] === "true");
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

// ---- Screen two (anygame.77) -----------------------------------------------
// Under Core 3.3.9 Steam's game page is two screens: screen one is the hero
// art, the logo and the play bar, and NOTHING is drawn there; screen two (one
// press down from the play bar) is Core's `AppDetailsContainer`
// (basicAppDetailsSectionStylerClasses), holding Steam's tabbed page: the tab
// row (`gamepadTabbedPageClasses.TabRow`) and each tab's section cards
// (`AppDetailsSection`, inside `AppDetailSectionList`). Forge's Mods tab goes
// into that tabbed page's `tabs` prop, and its Overview card among the section
// cards. Placement order: forgeRules.gamePagePlacement.
//
// anygame.72-.76 looked for the tabs only in components handed the game
// (`overview` / `details` props) within four levels of the overview panel;
// on the TV that chain did not reach them. So the patch now finds the way
// itself: an invisible scout in InnerContainer looks up screen two in the DOM
// by its class, climbs from that element through React's fibers to the
// overview panel, and remembers the component types on the way. Every render
// the patch follows below the panel then also follows those types, down to
// the render that holds the tabbed page or the section list.

/** True when the element carries one of `names` as a whole class. */
export function hasClass(node: any, names: string[]): boolean {
  const cls = node?.props?.className;
  if (typeof cls !== "string" || !cls) return false;
  const tokens = cls.split(/\s+/);
  return names.some((name) => tokens.includes(name));
}

/** How many levels below the overview panel components handed the game are
 * followed (the anygame.71 search, kept: cheap, and it may find the tabs on
 * a Steam build where they are close). */
export const CARRIER_DEPTH = 4;
/** How many game carriers one render may hand on. */
export const MAX_CARRIERS = 8;
/** How deep the discovered path may be followed, in components. */
export const MAX_FOLLOW_DEPTH = 40;
/** How many discovered-path elements one render may hand on. */
export const MAX_PATH_CARRIERS = 12;

/** A React component element whose type the tree patcher can follow: a
 * function or class component, a memo or a forwardRef. Host elements
 * ("div"), fragments and context objects are not. */
export function isFollowable(node: any): boolean {
  const type = node?.type;
  if (typeof type === "function") return true;
  if (!type || typeof type !== "object") return false;
  return typeof type.render === "function" || typeof type.type === "function" || typeof type.type === "object";
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function isElementLike(value: any): boolean {
  return isObject(value) && "type" in value && "props" in value;
}

/** Calls `visit` for every element in one render, in tree order: through
 * props.children, through any prop that holds an element, and through the
 * `content` of a tab list (a tabbed page's tab contents are props, not
 * children). Stops when `visit` returns true. Cycle-safe and bounded. */
export function walkRender(tree: any, visit: (node: any) => boolean | void, maxDepth = 64): void {
  const seen = new Set<any>();
  let stop = false;
  const walk = (node: any, depth: number): void => {
    if (stop || depth > maxDepth || !node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const props = node.props;
    if (!props || typeof props !== "object") return;
    if (visit(node) === true) {
      stop = true;
      return;
    }
    walk(props.children, depth + 1);
    for (const key of Object.keys(props)) {
      if (key === "children") continue;
      const value = props[key];
      if (isElementLike(value)) walk(value, depth + 1);
      else if (TAB_PROPS.includes(key) && Array.isArray(value)) {
        for (const tab of value) if (isElementLike(tab?.content)) walk(tab.content, depth + 1);
      }
    }
  };
  walk(tree, 0);
}

/** Components in one render that are handed the game (`overview` or
 * `details` props), in tree order, at most `limit`. Only `props.children` is
 * walked, never the props themselves (an overview object is not a tree). */
export function gameCarriers(tree: any, limit: number = MAX_CARRIERS): any[] {
  const out: any[] = [];
  const seen = new Set<any>();
  const walk = (node: any, depth: number): void => {
    if (out.length >= limit || depth > 64 || !node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const props = node.props;
    if (!props || typeof props !== "object") return;
    if (isFollowable(node) && (isObject(props.overview) || isObject(props.details))) out.push(node);
    walk(props.children, depth + 1);
  };
  walk(tree, 0);
  return out;
}

/** Elements in one render whose type is on a discovered path, at most
 * `limit`, in tree order. */
export function pathElements(tree: any, types: ReadonlySet<unknown>, limit: number = MAX_PATH_CARRIERS): any[] {
  const out: any[] = [];
  if (!types.size) return out;
  walkRender(tree, (node) => {
    if (types.has(node.type) && isFollowable(node)) out.push(node);
    return out.length >= limit;
  });
  return out;
}

/** A short outline of a render (type, class, prop names), logged once when
 * nothing was placed, so a TV log shows what Steam drew instead. */
export function outlineTree(tree: any, maxDepth = 6, maxLines = 60): string[] {
  const lines: string[] = [];
  const seen = new Set<any>();
  const walk = (node: any, depth: number): void => {
    if (lines.length >= maxLines || depth > maxDepth || !node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth);
      return;
    }
    const props = node.props ?? {};
    const cls = typeof props.className === "string" && props.className ? ` .${props.className.slice(0, 60)}` : "";
    const keys = Object.keys(props).filter((k) => k !== "children" && k !== "className").slice(0, 8);
    lines.push(`${"  ".repeat(depth)}${typeName(node.type)}${cls}${keys.length ? ` {${keys.join(",")}}` : ""}`);
    walk(props.children, depth + 1);
  };
  walk(tree, 0);
  return lines;
}

/** A readable name for a component type (minified on Steam, but stable for a
 * build and enough to compare two TV logs). */
export function typeName(t: any): string {
  if (typeof t === "string") return t;
  if (typeof t === "function") return t.displayName || t.name || "fn";
  if (t && typeof t === "object") {
    const inner = t.render ?? t.type;
    const name = t.displayName || inner?.displayName || inner?.name;
    return `${typeof t.render === "function" ? "forwardRef" : t.type ? "memo" : "object"}(${name || "?"})`;
  }
  return typeof t === "symbol" ? "fragment" : String(t);
}

// ---- React fibers (the scout's climb) --------------------------------------

/** The React fiber behind a DOM element (`__reactFiber$...`, or the older
 * `__reactInternalInstance$...`), or undefined. */
export function fiberOf(el: any): any {
  if (!el || typeof el !== "object") return undefined;
  try {
    for (const key of Object.keys(el)) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) return el[key];
    }
  } catch {
    // a hostile element: no fiber
  }
  return undefined;
}

/** The overview panel's fiber: rendered with `overview`, `details` and
 * `bFastRender`, the same props `overviewIndex` keys on. */
export function isOverviewFiber(f: any): boolean {
  const p = f?.memoizedProps;
  return isObject(p) && p.overview !== undefined && p.details !== undefined && p.bFastRender !== undefined;
}

function fiberType(f: any): unknown {
  return f?.elementType ?? f?.type;
}

/** The component types from just below the overview panel down to `start`
 * (inclusive), outermost first, mapped through `original` (the patch swaps
 * types it follows for patched copies; a path must name Steam's own types).
 * Host elements, contexts and fragments are skipped. Undefined when the
 * overview panel is not an ancestor within `maxSteps`. */
export function componentPath(
  start: any,
  original: (t: unknown) => unknown = (t) => t,
  maxSteps = 120
): unknown[] | undefined {
  const out: unknown[] = [];
  let f = start;
  for (let i = 0; f && i < maxSteps; i++, f = f.return) {
    if (isOverviewFiber(f)) return out.reverse();
    const t = fiberType(f);
    if (isFollowable({ type: t })) out.push(original(t));
  }
  return undefined;
}

/** The fiber of the element that carries a tab list (`tabs` or `sections`,
 * the tabbed page), from a DOM node inside its tab row upward; stops at the
 * overview panel. */
export function tabPageFiber(start: any, maxSteps = 60): any {
  let f = start;
  for (let i = 0; f && i < maxSteps; i++, f = f.return) {
    if (isOverviewFiber(f)) return undefined;
    const p = f.memoizedProps;
    if (isObject(p) && TAB_PROPS.some((k) => tabShape(p[k]))) return f;
  }
  return undefined;
}

/** A short outline of the fibers from `start` upward (type, class, prop
 * names), for the "nothing placed" log line. */
export function fiberOutline(start: any, maxLines = 30): string[] {
  const lines: string[] = [];
  let f = start;
  for (let i = 0; f && lines.length < maxLines; i++, f = f.return) {
    const p = isObject(f.memoizedProps) ? f.memoizedProps : {};
    const cls = typeof p.className === "string" && p.className ? ` .${p.className.slice(0, 60)}` : "";
    const keys = Object.keys(p).filter((k) => k !== "children" && k !== "className").slice(0, 8);
    lines.push(`${typeName(fiberType(f))}${cls}${keys.length ? ` {${keys.join(",")}}` : ""}${isOverviewFiber(f) ? "  <- overview panel" : ""}`);
    if (isOverviewFiber(f)) break;
  }
  return lines;
}

/** Screen two's classes as the loader maps them; any may be missing. */
export interface ScreenTwoClasses {
  /** basicAppDetailsSectionStylerClasses.AppDetailsContainer */
  container?: string;
  /** gamepadTabbedPageClasses.TabRow (TabRowTabs as a second try) */
  tabRow?: string[];
  /** basicAppDetailsSectionStylerClasses.AppDetailSectionList */
  sectionList?: string;
  /** appdetailssection's AppDetailsSection / AppDetailsSectionContainer */
  section?: string[];
}

/** How to find the section list's host element in a render. */
export interface HostMatch {
  /** A whole class it carries (AppDetailSectionList), when known. */
  token?: string;
  /** Else its exact className, read from the DOM. */
  exact?: string;
}

export interface ScreenTwo {
  /** Screen two's container was found in the DOM. */
  container: boolean;
  tabRow: boolean;
  /** Types from below the overview panel down to the tabbed page's parent. */
  tabPath?: unknown[];
  sections: boolean;
  /** Types from below the overview panel down to the section list's parent. */
  sectionPath?: unknown[];
  sectionHost?: HostMatch;
  /** What was seen, for the log line when nothing could be placed. */
  outline: string[];
}

function query(root: any, cls: string | undefined): any {
  if (!cls || !root || typeof root.querySelector !== "function") return null;
  try {
    return root.querySelector(`.${cls}`);
  } catch {
    return null;
  }
}

/** Looks up screen two inside `root` (the page's InnerContainer element, from
 * the scout) and the component paths down to its tabbed page and section
 * list. Never throws. */
export function discoverScreenTwo(
  root: any,
  cls: ScreenTwoClasses,
  original: (t: unknown) => unknown = (t) => t
): ScreenTwo {
  const out: ScreenTwo = { container: false, tabRow: false, sections: false, outline: [] };
  try {
    const container = query(root, cls.container);
    out.container = Boolean(container);
    const scope = container ?? root;
    out.outline.push(
      `screen two: container ${container ? "found" : cls.container ? "not found" : "class unknown"}`
    );

    let tabRow: any = null;
    for (const c of cls.tabRow ?? []) if (!tabRow) tabRow = query(scope, c);
    out.tabRow = Boolean(tabRow);
    if (tabRow) {
      const page = tabPageFiber(fiberOf(tabRow));
      const path = page ? componentPath(page.return, original) : undefined;
      if (path) out.tabPath = path;
      out.outline.push(
        `tab row found; ${page ? "tabbed page found" : "no tabs prop above it"}; ${path ? `path ${path.length} deep` : "no path to the overview panel"}`
      );
      if (!path) out.outline.push(...fiberOutline(fiberOf(tabRow)).map((l) => `  ${l}`));
    } else {
      out.outline.push(`tab row ${cls.tabRow?.length ? "not found" : "class unknown"}`);
    }

    let list: any = query(scope, cls.sectionList);
    let host: HostMatch | undefined = list && cls.sectionList ? { token: cls.sectionList } : undefined;
    if (!list) {
      let first: any = null;
      for (const c of cls.section ?? []) if (!first) first = query(scope, c);
      list = first?.parentElement ?? null;
      const exact = fiberOf(list)?.memoizedProps?.className ?? list?.className;
      if (list && typeof exact === "string" && exact) host = { exact };
    }
    out.sections = Boolean(list && host);
    if (list && host) {
      const path = componentPath(fiberOf(list)?.return, original);
      if (path) {
        out.sectionPath = path;
        out.sectionHost = host;
      }
      out.outline.push(`section list found; ${path ? `path ${path.length} deep` : "no path to the overview panel"}`);
      if (!path) out.outline.push(...fiberOutline(fiberOf(list)).map((l) => `  ${l}`));
    } else {
      out.outline.push(`section cards ${cls.sectionList || cls.section?.length ? "not found" : "class unknown"}`);
    }
  } catch (e) {
    out.outline.push(`screen two lookup failed: ${String(e)}`);
  }
  return out;
}

/** What the scout found, kept for the session (component types are fixed for
 * a Steam build), so a game page opened later is placed on its first render. */
export class ScreenTwoPaths {
  readonly types = new Set<unknown>();
  tabFound = false;
  sectionHost?: HostMatch;
  private listeners = new Set<() => void>();

  /** Adds a discovery; true when it taught anything new. */
  learn(s: ScreenTwo): boolean {
    let fresh = false;
    for (const path of [s.tabPath, s.sectionPath]) {
      for (const t of path ?? []) {
        if (!this.types.has(t)) {
          this.types.add(t);
          fresh = true;
        }
      }
    }
    if (s.tabPath && !this.tabFound) {
      this.tabFound = true;
      fresh = true;
    }
    if (s.sectionHost && !this.sectionHost) {
      this.sectionHost = s.sectionHost;
      fresh = true;
    }
    if (fresh) this.emit();
    return fresh;
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

export const screenTwo = new ScreenTwoPaths();

/** The section list's host element in one render: an element with array
 * children that matches `match`. Undefined when none is in this render. */
export function findSectionHost(tree: any, match: HostMatch | undefined): any {
  if (!match || (!match.token && !match.exact)) return undefined;
  let found: any;
  walkRender(tree, (node) => {
    const cls = node.props?.className;
    if (typeof cls !== "string") return false;
    const hit = match.token ? hasClass(node, [match.token]) : cls === match.exact;
    if (hit && node.props.children !== undefined) {
      found = node;
      return true;
    }
    return false;
  });
  return found;
}

/** Where the card goes among the section cards: second, after Steam's first
 * card (the board's order: Achievements, Mods, Cloud saves...). */
export const CARD_INDEX = 1;

/** Puts `element` among the host's children at CARD_INDEX (a new array when
 * the host had a single child), unless an element with `key` is there.
 * Returns where it went, or -1. */
export function insertCard(host: any, element: any, key: string): number {
  const props = host?.props;
  if (!props) return -1;
  const kids = props.children;
  const list: any[] = Array.isArray(kids) ? kids : kids === undefined || kids === null ? [] : [kids];
  if (list.some((c: any) => c?.key === key)) return -1;
  const at = Math.min(CARD_INDEX, list.length);
  try {
    if (Array.isArray(kids)) kids.splice(at, 0, element);
    else props.children = [...list.slice(0, at), element, ...list.slice(at)];
    return at;
  } catch {
    return -1;
  }
}

/** Which copies of the card are on screen: should Steam draw the section
 * list twice, only the first copy mounted is shown. */
export class PlacementRegistry {
  private mounted = new Map<number, object[]>();
  private listeners = new Set<() => void>();

  /** Registers a mounted card; call the returned function on unmount. */
  mount(appId: number, token: object = {}): () => void {
    const list = this.mounted.get(appId) ?? [];
    list.push(token);
    this.mounted.set(appId, list);
    this.emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const now = this.mounted.get(appId) ?? [];
      const at = now.indexOf(token);
      if (at >= 0) now.splice(at, 1);
      if (now.length) this.mounted.set(appId, now);
      else this.mounted.delete(appId);
      this.emit();
    };
  }

  has(appId: number): boolean {
    return (this.mounted.get(appId)?.length ?? 0) > 0;
  }

  /** True when `token` is the first copy still mounted for the game. */
  isFirst(appId: number, token: object): boolean {
    return this.mounted.get(appId)?.[0] === token;
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

/** How long the scout looks for screen two before it gives up and logs the
 * page outline (Steam can draw screen two late, after the art). */
export const SCOUT_TRIES_MS = [250, 700, 1500, 3000, 6000];

/** Says once per session where Forge went (the console line a TV test
 * reads). When nothing could be placed, the line carries the outline of the
 * overview panel's render and what the scout saw on screen two. */
export class PlacementLog {
  private said = new Set<string>();
  private outline: string[] = [];

  constructor(private readonly out: (message: string) => void = (m) => console.info(m)) {}

  /** Logs `Forge game page: Mods <path>` the first time `path` is seen;
   * `detail` is appended but not part of what counts as seen. */
  note(path: string, detail = ""): boolean {
    if (this.said.has(path)) return false;
    this.said.add(path);
    try {
      this.out(`Forge game page: Mods ${path}${detail}`);
    } catch {
      // logging must never break the page
    }
    return true;
  }

  /** Keeps the overview panel's render outline for the "nothing" line. */
  rememberOutline(lines: string[]): void {
    if (!this.outline.length && lines.length) this.outline = lines.slice();
  }

  /** Neither Steam's tab row nor its section cards were found: nothing is
   * drawn (never on screen one), and the page outline is logged once. */
  noteNothing(seen: string[] = []): boolean {
    const lines = [...seen, ...(this.outline.length ? ["overview panel render:", ...this.outline] : [])];
    return this.note(
      "not shown: neither Steam's tab row nor its section cards were found on screen two (nothing is drawn on screen one)",
      lines.length ? `\n${lines.join("\n")}` : ""
    );
  }
}

export const placementLog = new PlacementLog();

/** The one registry the game page uses (GameModsSection reads and writes it). */
export const placements = new PlacementRegistry();

// ---- Steam's own tab container (anygame.72) --------------------------------
// Mods become a tab beside Steam's own when a render below the overview panel
// holds a tab container: an element handed an array of tabs, each with an id
// and a title (the shape of Steam's tabbed page and of @decky/ui's Tabs:
// `{ tabs: [{ id, title, content }], activeTab, onShowTab }`). Core's notes put
// it inside AppDetailsContainer on screen two; the scout above finds the way
// down to it (forgeRules.gamePagePlacement).

export interface TabContainer {
  /** The element whose props carry the tabs. */
  node: any;
  /** The prop holding the array ("tabs" or "sections"). */
  prop: string;
  idKey: "id" | "key";
  titleKey: "title" | "label";
}

const TAB_PROPS = ["tabs", "sections"];

function tabShape(list: unknown): { idKey: "id" | "key"; titleKey: "title" | "label" } | undefined {
  if (!Array.isArray(list) || list.length < 2) return undefined;
  for (const idKey of ["id", "key"] as const) {
    for (const titleKey of ["title", "label"] as const) {
      const all = list.every(
        (t: any) =>
          t && typeof t === "object" && (typeof t[idKey] === "string" || typeof t[idKey] === "number") &&
          (typeof t[titleKey] === "string" || (t[titleKey] && typeof t[titleKey] === "object"))
      );
      if (all) return { idKey, titleKey };
    }
  }
  return undefined;
}

/** The first tab container in one render (tree order), or undefined.
 * Walked like walkRender: children, element-valued props and tab contents. */
export function findTabContainer(tree: any, maxDepth = 64): TabContainer | undefined {
  let found: TabContainer | undefined;
  walkRender(
    tree,
    (node) => {
      for (const prop of TAB_PROPS) {
        const shape = tabShape(node.props[prop]);
        if (shape) {
          found = { node, prop, ...shape };
          return true;
        }
      }
      return false;
    },
    maxDepth
  );
  return found;
}

/** Puts Forge's tab last in the container's tab list (a new array, so a list
 * Steam reuses is never changed in place). False when it was already there
 * or the props could not be written. */
export function addTab(c: TabContainer, id: string, title: string, content: unknown): boolean {
  const list: any[] = c.node.props[c.prop];
  if (list.some((t: any) => t?.[c.idKey] === id)) return false;
  const tab: Record<string, unknown> = { ...(list[list.length - 1] ?? {}) };
  for (const k of Object.keys(tab)) if (typeof tab[k] === "function" || k === "content" || k === "footer") delete tab[k];
  tab[c.idKey] = id;
  tab[c.titleKey] = title;
  tab.content = content;
  try {
    c.node.props[c.prop] = [...list, tab];
    return true;
  } catch {
    return false;
  }
}

/** The card's second home: appended to the first tab's content when Steam's
 * section list could not be found but its tabbed page could. `wrap` builds
 * the new content from the old (React lives in the caller). The first tab
 * keeps its id, so Steam's selection is unchanged. */
export function addCardToFirstTab(c: TabContainer, key: string, wrap: (content: unknown) => unknown): boolean {
  const list: any[] = c.node.props[c.prop];
  const first = list[0];
  if (!first || first.__forgeCard === key) return false;
  try {
    c.node.props[c.prop] = [{ ...first, content: wrap(first.content), __forgeCard: key }, ...list.slice(1)];
    return true;
  } catch {
    return false;
  }
}

/** True when the tabbed page shows its first tab (Steam's Overview), or says
 * nothing about which one it shows: the card belongs there only. */
export function firstTabActive(c: TabContainer): boolean {
  const props = c.node?.props ?? {};
  const active = props.activeTab ?? props.selectedTab ?? props.strActiveTab;
  if (active === undefined || active === null) return true;
  const first = props[c.prop]?.[0];
  return first?.[c.idKey] === active;
}

/** Steam's way to switch tabs, when the container is controlled
 * (`onShowTab(id)`), else undefined. */
export function tabSwitcher(c: TabContainer): ((id: string) => void) | undefined {
  const fn = c.node?.props?.onShowTab ?? c.node?.props?.onSelectTab ?? c.node?.props?.onTabChange;
  return typeof fn === "function" ? fn : undefined;
}

/** Remembers, per game, how to open Forge's Steam tab, so the Overview
 * card's X can switch to it. Falls back to the in-place tab when Steam's tab
 * could not be opened. */
export class SteamTabs {
  private openers = new Map<number, ((id: string) => void) | undefined>();
  private listeners = new Set<() => void>();

  /** Forge's tab was added to the game's Steam tab container; `open` is
   * Steam's switcher when the container is controlled. */
  note(appId: number, open: ((id: string) => void) | undefined): void {
    const had = this.openers.has(appId);
    const before = this.openers.get(appId);
    this.openers.set(appId, open);
    if (!had || before !== open) this.emit();
  }

  /** The page was drawn again without a tab container. */
  clear(appId: number): void {
    if (this.openers.delete(appId)) this.emit();
  }

  /** Forge's tab is in Steam's tab container for this game. */
  injected(appId: number): boolean {
    return this.openers.has(appId);
  }

  /** Steam's tab can be switched to from the card. */
  has(appId: number): boolean {
    return typeof this.openers.get(appId) === "function";
  }

  /** True when Steam was asked to show the tab. */
  open(appId: number, id: string): boolean {
    const fn = this.openers.get(appId);
    if (typeof fn !== "function") return false;
    try {
      fn(id);
      return true;
    } catch {
      this.openers.set(appId, undefined);
      return false;
    }
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

export const steamTabs = new SteamTabs();
