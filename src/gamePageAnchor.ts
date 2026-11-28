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
      else if (Array.isArray(value) && (TAB_PROPS.includes(key) || tabShape(value))) {
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

/** The component types from just below the overview panel (or the first
 * ancestor `stop` accepts) down to `start` (inclusive), outermost first, mapped through `original` (the patch swaps
 * types it follows for patched copies; a path must name Steam's own types).
 * Host elements, contexts and fragments are skipped. Undefined when the
 * overview panel is not an ancestor within `maxSteps`. */
export function componentPath(
  start: any,
  original: (t: unknown) => unknown = (t) => t,
  maxSteps = 120,
  stop: (f: any) => boolean = isOverviewFiber
): unknown[] | undefined {
  const out: unknown[] = [];
  let f = start;
  for (let i = 0; f && i < maxSteps; i++, f = f.return) {
    if (stop(f)) return out.reverse();
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
    if (isObject(p) && findTabProp(p)) return f;
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

/** Screen two's classes, each the union of every Steam class module that
 * carries it (anygame.78: Steam ships duplicate modules with the same keys and
 * different hashes, and either copy may be the one on screen). Any may be
 * empty. */
export interface ScreenTwoClasses {
  /** appdetails (basicappdetailssectionstyler) AppDetailsContainer */
  container?: string[];
  /** tabbedpage TabRow (TabRowTabs as a second try) */
  tabRow?: string[];
  /** appdetails AppDetailSectionList */
  sectionList?: string[];
  /** appsection AppDetailsSection / AppDetailsSectionContainer */
  section?: string[];
}

/** How to find the section list's host element in a render. */
export interface HostMatch {
  /** Whole classes it may carry (AppDetailSectionList, every copy), when known. */
  tokens?: string[];
  /** Else its exact className, read from the DOM. */
  exact?: string;
}

export interface ScreenTwo {
  /** Screen two's container was found in the DOM. */
  container: boolean;
  tabRow: boolean;
  /** The element carrying the tab list was found above the tab row. */
  tabbedPage: boolean;
  /** That element's component type (Steam's tabbed page), for the global patch. */
  tabbedType?: unknown;
  /** Types from below the overview panel down to the tabbed page's parent. */
  tabPath?: unknown[];
  sections: boolean;
  /** Types from below the overview panel down to the section list's parent. */
  sectionPath?: unknown[];
  /** Types from below the tabbed page down to the section list's parent (the
   * way from the first tab's content to the cards). */
  contentPath?: unknown[];
  sectionHost?: HostMatch;
  /** What was seen, for the log line when nothing could be placed. */
  outline: string[];
}

/** A CSS selector list for a set of class values (each may hold several
 * space-separated names, or `|`-separated alternatives as Core writes merged
 * maps). Names that are not plain class names are dropped; undefined when
 * nothing is left. */
export function classSelector(values: readonly (string | undefined)[] | undefined): string | undefined {
  const out: string[] = [];
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    for (const alt of value.split("|")) {
      const names = alt.trim().split(/\s+/).filter(Boolean);
      if (!names.length || !names.every((n) => CLASS_NAME.test(n))) continue;
      const sel = "." + names.join(".");
      if (!out.includes(sel)) out.push(sel);
    }
  }
  return out.length ? out.join(",") : undefined;
}

const CLASS_NAME = /^-?[A-Za-z_][\w-]*$/;

function query(root: any, cls: readonly string[] | undefined): any {
  const sel = classSelector(cls);
  if (!sel || !root || typeof root.querySelector !== "function") return null;
  try {
    return root.querySelector(sel);
  } catch {
    return null;
  }
}

/** The scopes the scout searches, closest first: the element it sits in, then
 * up to `levels` ancestors (screen two may sit beside InnerContainer rather
 * than inside it on some Steam builds). */
export function scoutScopes(root: any, levels = 3): any[] {
  const out: any[] = [];
  for (let el = root, i = 0; el && i <= levels; i++, el = el.parentElement) out.push(el);
  return out;
}

/** The fiber that carries a tab list (any tab-shaped prop): Steam's tabbed page. */
export function isTabbedFiber(f: any): boolean {
  const p = f?.memoizedProps;
  return isObject(p) && Boolean(findTabProp(p));
}

/** Looks up screen two inside `root` (the page's InnerContainer element, from
 * the scout; its ancestors as a second try) and the component paths down to
 * its tabbed page and section list. Never throws. */
export function discoverScreenTwo(
  root: any,
  cls: ScreenTwoClasses,
  original: (t: unknown) => unknown = (t) => t
): ScreenTwo {
  const out: ScreenTwo = { container: false, tabRow: false, tabbedPage: false, sections: false, outline: [] };
  try {
    let container: any = null;
    let scope: any = root;
    for (const s of scoutScopes(root)) {
      container = query(s, cls.container);
      if (container) break;
    }
    out.container = Boolean(container);
    if (container) scope = container;
    out.outline.push(
      `screen two: container ${container ? "found" : cls.container?.length ? "not found" : "class unknown"}`
    );

    let tabRow: any = query(scope, cls.tabRow);
    if (!tabRow && !container) for (const s of scoutScopes(root).slice(1)) if (!tabRow) tabRow = query(s, cls.tabRow);
    out.tabRow = Boolean(tabRow);
    if (tabRow) {
      const page = tabPageFiber(fiberOf(tabRow));
      out.tabbedPage = Boolean(page);
      if (page) out.tabbedType = original(fiberType(page));
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
    let host: HostMatch | undefined = list && cls.sectionList?.length ? { tokens: [...cls.sectionList] } : undefined;
    if (!list) {
      const first = query(scope, cls.section);
      list = first?.parentElement ?? null;
      const exact = fiberOf(list)?.memoizedProps?.className ?? list?.className;
      if (list && typeof exact === "string" && exact) host = { exact };
    }
    out.sections = Boolean(list && host);
    if (list && host) {
      out.sectionHost = host;
      const start = fiberOf(list)?.return;
      const path = componentPath(start, original);
      if (path) out.sectionPath = path;
      const content = componentPath(start, original, 120, isTabbedFiber);
      if (content) out.contentPath = content;
      out.outline.push(
        `section list found; ${path ? `path ${path.length} deep` : "no path to the overview panel"}; ${content ? `${content.length} below the tabbed page` : "not under a tabbed page"}`
      );
      if (!path && !content) out.outline.push(...fiberOutline(fiberOf(list)).map((l) => `  ${l}`));
    } else {
      out.outline.push(`section cards ${cls.sectionList?.length || cls.section?.length ? "not found" : "class unknown"}`);
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
    for (const path of [s.tabPath, s.sectionPath, s.contentPath]) {
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
  if (!match || (!match.tokens?.length && !match.exact)) return undefined;
  const tokens = (match.tokens ?? []).flatMap((t) => t.split("|")).map((t) => t.trim()).filter(Boolean);
  let found: any;
  walkRender(tree, (node) => {
    const cls = node.props?.className;
    if (typeof cls !== "string") return false;
    const hit = tokens.length ? tokens.some((t) => t.split(/\s+/).every((n) => hasClass(node, [n]))) : cls === match.exact;
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
   * drawn (never on screen one). Logs once: `line` (the diagnostic, one line
   * saying which class maps, keys and page parts were found or missing), then
   * on a second line what the scout saw and the overview panel's render. */
  noteNothing(line: string, seen: string[] = []): boolean {
    if (this.said.has(NOTHING)) return false;
    this.said.add(NOTHING);
    const lines = [...seen, ...(this.outline.length ? ["overview panel render:", ...this.outline] : [])];
    try {
      this.out(line);
      if (lines.length) this.out(`Forge game page: outline\n${lines.join("\n")}`);
    } catch {
      // logging must never break the page
    }
    return true;
  }
}

const NOTHING = "\u0000nothing";

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

/** The prop of `props` that holds a tab list: `tabs` or `sections` first,
 * then any other array of tabs that carry content. */
export function findTabProp(props: any): { prop: string; idKey: "id" | "key"; titleKey: "title" | "label" } | undefined {
  if (!isObject(props)) return undefined;
  try {
    for (const prop of TAB_PROPS) {
      const shape = tabShape(props[prop]);
      if (shape) return { prop, ...shape };
    }
    for (const prop of Object.keys(props)) {
      if (TAB_PROPS.includes(prop) || prop === "children") continue;
      const list = props[prop];
      const shape = tabShape(list);
      if (shape && (list as any[]).every((t: any) => "content" in t)) return { prop, ...shape };
    }
  } catch {
    // hostile props: no tab list
  }
  return undefined;
}

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
      const shape = findTabProp(node.props);
      if (shape) {
        found = { node, ...shape };
        return true;
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

// ---- Class maps: every duplicate module, merged (anygame.78) ----------------
// .77 took one module per map (@decky/ui's named exports and findClassModule
// answer the FIRST module carrying a key). Steam ships some class modules two
// or three times with identical keys and different hashes (Core 3.3.11 found
// this), and the copy the game page draws may be the other one: on the TV the
// scout then found nothing. Now every module that carries a map's keys is
// taken, and each key holds every copy's class. The hashes change with Steam
// builds, so nothing here names one: maps are found by their key names.

/** A Steam class map Forge reads, by the keys every copy carries. `alt` is a
 * second key set tried when no module carries `all`. */
export interface ClassMapSpec {
  all: string[];
  alt?: string[];
}

/** The maps screen two needs (names follow Core's CORE-UI.md). */
export const CLASS_MAP_SPECS: Record<string, ClassMapSpec> = {
  tabbedpage: { all: ["GamepadTabbedPage", "TabRow", "Tab", "Selected"], alt: ["TabRow", "Tab", "TabTitle"] },
  appdetails: { all: ["AppDetailsContainer", "PlaySection"], alt: ["AppDetailsContainer", "AppDetailsRoot"] },
  appsection: { all: ["AppDetailsSection", "AppDetailsSectionContainer"] },
  appview: { all: ["HeaderLoaded", "InnerContainer"] },
};

/** The keys screen two reads from each map, for the diagnostic line. */
export const CLASS_MAP_KEYS: Record<string, string[]> = {
  tabbedpage: ["GamepadTabbedPage", "TabRow", "TabRowTabs", "Tab", "Selected", "TabTitle"],
  appdetails: ["AppDetailsContainer", "AppDetailsRoot", "AppDetailSectionList", "PlaySection"],
  appsection: ["AppDetailsSection", "AppDetailsSectionContainer"],
  appview: ["InnerContainer"],
};

/** A merged class map: each key holds every distinct class the copies carry. */
export type ClassUnion = Record<string, string[]>;

export interface ClassMapReport {
  /** How many distinct Steam modules matched (duplicates included). */
  modules: number;
  /** Where the classes came from. */
  source: "core" | "steam" | "core+steam" | "none";
  /** Whether the second key set was needed. */
  alt: boolean;
}

function looksLikeClassMap(value: any): boolean {
  if (!isObject(value) || Array.isArray(value)) return false;
  try {
    const entries = Object.entries(value);
    return entries.length > 0 && entries.length <= 1200 && entries.every(([, v]) => typeof v === "string");
  } catch {
    return false;
  }
}

function sameMap(a: any, b: any): boolean {
  if (a === b) return true;
  try {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
  } catch {
    return false;
  }
}

/** Every Steam class map the loader can show, each once: @decky/ui 4's
 * `classMap` list (Decky 3.3.1), then a full walk through `findClassModule`,
 * `findVar` and `findModuleScopeByVar` (@decky/ui 5, Decky 4) with a filter
 * that never accepts, so every module is visited. Never throws. */
export function collectClassModules(ui: any, limit = 20000): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const seen = new Set<any>();
  const visit = (value: any): false => {
    if (out.length >= limit || !value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (looksLikeClassMap(value)) out.push(value);
    return false;
  };
  try {
    const list = ui?.classMap;
    if (Array.isArray(list)) for (const m of list) visit(m);
  } catch {
    // no classMap on this loader
  }
  for (const name of ["findClassModule", "findVar"]) {
    const find = finder(ui, name);
    if (!find) continue;
    try {
      find(visit);
    } catch {
      // a walk that throws part way keeps what it saw
    }
  }
  const byScope = finder(ui, "findModuleScopeByVar");
  if (byScope) {
    try {
      byScope((value: unknown) => visit(value));
    } catch {
      // as above
    }
  }
  return out;
}

/** Adds every class of `map` (values may hold `|`-separated alternatives) to `into`. */
function addClasses(into: ClassUnion, map: any): void {
  try {
    for (const key of Object.keys(map)) {
      const value = map[key];
      if (typeof value !== "string" || !value) continue;
      for (const alt of value.split("|")) {
        const cls = alt.trim();
        if (!cls) continue;
        const list = into[key] ?? (into[key] = []);
        if (!list.includes(cls)) list.push(cls);
      }
    }
  } catch {
    // a hostile map adds nothing
  }
}

function carries(map: any, keys: string[]): boolean {
  try {
    return keys.every((k) => typeof map?.[k] === "string" && map[k].length > 0);
  } catch {
    return false;
  }
}

/** Merges, per map in `specs`, EVERY module that carries its keys (never just
 * the first), plus the map Core resolved when Core publishes one (`core`,
 * name -> map with `|`-separated alternatives). */
export function resolveClassUnion(
  modules: readonly any[],
  specs: Record<string, ClassMapSpec> = CLASS_MAP_SPECS,
  core?: Record<string, any>
): { maps: Record<string, ClassUnion>; report: Record<string, ClassMapReport> } {
  const maps: Record<string, ClassUnion> = {};
  const report: Record<string, ClassMapReport> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const union: ClassUnion = {};
    const fromCore = core && isObject(core[name]) && carries(core[name], spec.alt && !carries(core[name], spec.all) ? spec.alt : spec.all);
    if (fromCore) addClasses(union, core![name]);
    const distinct: any[] = [];
    let alt = false;
    for (const keys of [spec.all, spec.alt]) {
      if (!keys || distinct.length) continue;
      for (const m of modules) {
        if (carries(m, keys) && !distinct.some((d) => sameMap(d, m))) distinct.push(m);
      }
      if (distinct.length && keys === spec.alt) alt = true;
    }
    for (const m of distinct) addClasses(union, m);
    maps[name] = union;
    report[name] = {
      modules: distinct.length,
      source: fromCore && distinct.length ? "core+steam" : fromCore ? "core" : distinct.length ? "steam" : "none",
      alt,
    };
  }
  return { maps, report };
}

/** Screen two's classes from the merged maps. */
export function screenTwoClassesFrom(maps: Record<string, ClassUnion>): ScreenTwoClasses {
  const list = (...xs: (string[] | undefined)[]) => xs.flatMap((x) => x ?? []);
  return {
    container: list(maps.appdetails?.AppDetailsContainer),
    sectionList: list(maps.appdetails?.AppDetailSectionList),
    tabRow: list(maps.tabbedpage?.TabRow, maps.tabbedpage?.TabRowTabs),
    section: list(maps.appsection?.AppDetailsSection, maps.appsection?.AppDetailsSectionContainer),
  };
}

/** The class maps Core resolved, if a Core build publishes them on the window
 * (`window[Symbol.for("core.ui.classMaps")]`, an object or a function
 * answering one: map name -> key -> class, `|`-separated for merged copies).
 * Core 3.3.11 publishes none (only `core.ui.diagnostics`, which carries no
 * classes); Forge reads it if a later Core does, and merges its own lookup in
 * either way. */
export const CORE_CLASS_MAPS_KEY = "core.ui.classMaps";
export function coreClassMaps(host: any): Record<string, any> | undefined {
  try {
    const value = host?.[Symbol.for(CORE_CLASS_MAPS_KEY)];
    const maps = typeof value === "function" ? value() : value;
    return isObject(maps) ? maps : undefined;
  } catch {
    return undefined;
  }
}

// ---- Steam's tabbed page, patched where it is defined (anygame.78) ---------
// .77 reached Steam's tabbed page only by following components down from the
// overview panel along a path the scout learned, and only from a redraw after
// that: on the TV nothing appeared. anygame.78 patches the tabbed page
// component itself, once, at load: Steam's GamepadTabbedPage is a React memo
// (the component @decky/ui exports as `Tabs`), and a memo's inner `type` can be
// swapped for a wrapper. Every tabbed page mounted afterwards renders through
// Forge's wrapper, which passes everything through unchanged unless the scout
// on the current game page has confirmed that this tabbed page is that page's
// screen two (found in the fibers below the scout, no class names needed).

const MEMO = typeof Symbol === "function" ? Symbol.for("react.memo") : undefined;
/** Marks Forge's wrapper; its value is the function it wraps. */
export const FORGE_WRAPPED = typeof Symbol === "function" ? Symbol.for("forge.tabbedPage.original") : "__forgeOriginal";

export function isMemo(value: any): boolean {
  return isObject(value) && value.$$typeof === MEMO && typeof value.type === "function";
}

function isClassComponent(fn: any): boolean {
  try {
    return Boolean(fn?.prototype?.isReactComponent);
  } catch {
    return true;
  }
}

function sourceOf(fn: any): string {
  try {
    return typeof fn === "function" ? Function.prototype.toString.call(fn) : "";
  } catch {
    return "";
  }
}

/** True when a module is Steam's tabbed page module: one of its function
 * exports names the tab row (`TabRowTabs`) and the `activeTab` prop (the
 * signature @decky/ui 4 uses to find `Tabs`). */
export function isTabbedPageModule(mod: any): boolean {
  if (!isObject(mod) && typeof mod !== "function") return false;
  try {
    for (const key of Object.keys(mod)) {
      let value: any;
      try {
        value = mod[key];
      } catch {
        continue;
      }
      const fn = typeof value === "function" ? value : isMemo(value) ? value.type : undefined;
      const src = sourceOf(fn);
      if (src.includes("TabRowTabs") && src.includes("activeTab")) return true;
    }
  } catch {
    // a hostile module is not the tabbed page
  }
  return false;
}

/** Every memo export of every tabbed page module in `modules` (Steam may ship
 * the module more than once: all copies are taken), plus `extra` memos
 * (@decky/ui's `Tabs`). Class components are left out. Each memo once. */
export function findTabbedPageComponents(modules: Iterable<any>, extra: unknown[] = []): any[] {
  const out: any[] = [];
  const add = (m: any) => {
    if (isMemo(m) && !isClassComponent(m.type) && !out.includes(m)) out.push(m);
  };
  for (const e of extra) add(e);
  const hasMemo = (mod: any): boolean => {
    try {
      return Object.keys(mod).some((k) => {
        try {
          return isMemo(mod[k]);
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  };
  try {
    for (const mod of modules) {
      for (const candidate of [mod, (mod as any)?.default]) {
        // Cheap test first: only a module exporting a memo is read as source.
        if (!candidate || typeof candidate !== "object" || !hasMemo(candidate) || !isTabbedPageModule(candidate)) continue;
        try {
          for (const key of Object.keys(candidate)) {
            try {
              add(candidate[key]);
            } catch {
              // skip a throwing export
            }
          }
        } catch {
          // skip the module
        }
      }
    }
  } catch {
    // keep what was found
  }
  return out;
}

/** Swaps a memo's inner component for `build(original)`, once: a memo already
 * wrapped by Forge (an earlier load) is re-wrapped around its original.
 * Returns false when the memo cannot be written. */
export function wrapMemo(memo: any, build: (original: (...a: any[]) => any) => (...a: any[]) => any): boolean {
  if (!isMemo(memo)) return false;
  try {
    const current = memo.type;
    const original = (current as any)[FORGE_WRAPPED] ?? current;
    const wrapped = build(original);
    (wrapped as any)[FORGE_WRAPPED] = original;
    for (const k of ["displayName", "defaultProps", "propTypes"]) {
      if ((original as any)[k] !== undefined) (wrapped as any)[k] = (original as any)[k];
    }
    memo.type = wrapped;
    return memo.type === wrapped;
  } catch {
    return false;
  }
}

/** Puts Steam's own component back when Forge's wrapper is still the memo's
 * type (another plugin may have wrapped it since: then it is left, and the
 * wrapper passes everything through once Forge has unloaded). */
export function unwrapMemo(memo: any): boolean {
  try {
    const original = memo?.type?.[FORGE_WRAPPED];
    if (typeof original !== "function") return false;
    memo.type = original;
    return true;
  } catch {
    return false;
  }
}

/** Calls `visit` for every fiber below `start` (child and sibling links,
 * `start` itself excluded), depth first, at most `maxNodes`. Stops when
 * `visit` returns true. */
export function walkFibers(start: any, visit: (f: any) => boolean | void, maxNodes = 30000): number {
  let count = 0;
  const stack: any[] = [];
  if (start?.child) stack.push(start.child);
  const seen = new Set<any>();
  while (stack.length && count < maxNodes) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    count++;
    if (visit(f) === true) return count;
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  return count;
}

/** The records (from `lookup`, keyed by the props a tabbed page rendered with)
 * of the tabbed pages in the scout's page: the fibers below the scout's
 * parent, then below each ancestor up to `levels` (closest first; stops at
 * the first level that holds any). Both a fiber's and its alternate's props
 * are looked up. */
export function tabbedPagesNear<T>(
  scoutFiber: any,
  lookup: (props: unknown) => T | undefined,
  levels = 3,
  maxNodes = 30000
): T[] {
  const out: T[] = [];
  let anchor = scoutFiber?.return;
  for (let i = 0; anchor && i <= levels && !out.length; i++, anchor = anchor.return) {
    walkFibers(
      anchor,
      (f) => {
        for (const props of [f.memoizedProps, f.alternate?.memoizedProps]) {
          if (!isObject(props)) continue;
          const rec = lookup(props);
          if (rec !== undefined && !out.includes(rec)) out.push(rec);
        }
      },
      maxNodes
    );
  }
  return out;
}

/** The key a tabbed page reads its selected tab from. */
export function activeTabKey(props: any): string {
  for (const k of ["activeTab", "selectedTab", "strActiveTab"]) if (props?.[k] !== undefined) return k;
  return "activeTab";
}

/** The key a tabbed page calls to switch tabs, if any. */
export function showTabKey(props: any): string | undefined {
  for (const k of ["onShowTab", "onSelectTab", "onTabChange"]) if (typeof props?.[k] === "function") return k;
  return undefined;
}

export interface ForgeTabPlan {
  id: string;
  title: string;
  content: unknown;
  /** Forge's tab is the one shown (the tabbed page's own state left alone). */
  forgeActive: boolean;
  /** Replaces the tabbed page's switcher (Forge's tab is selected locally). */
  onShow?: (id: string) => void;
  /** Builds the first tab's new content from its old, or undefined to leave it. */
  firstContent?: (content: unknown) => unknown;
}

/** New props for Steam's tabbed page with Forge's tab last, never changing
 * Steam's own props, list or tab objects. Undefined when the props carry no
 * tab list. */
export function forgeTabProps(props: any, plan: ForgeTabPlan): any {
  const shape = findTabProp(props);
  if (!shape) return undefined;
  const list: any[] = props[shape.prop];
  const tabs = list.slice();
  if (!tabs.some((t: any) => t?.[shape.idKey] === plan.id)) {
    const tab: Record<string, unknown> = { ...(list[list.length - 1] ?? {}) };
    for (const k of Object.keys(tab)) if (typeof tab[k] === "function" || k === "content" || k === "footer") delete tab[k];
    tab[shape.idKey] = plan.id;
    tab[shape.titleKey] = plan.title;
    tab.content = plan.content;
    tabs.push(tab);
  }
  if (plan.firstContent && tabs[0] && tabs[0][shape.idKey] !== plan.id) {
    const content = plan.firstContent(tabs[0].content);
    if (content !== undefined && content !== tabs[0].content) tabs[0] = { ...tabs[0], content };
  }
  const next: any = { ...props, [shape.prop]: tabs };
  if (plan.forgeActive) next[activeTabKey(props)] = plan.id;
  if (plan.onShow) next[showTabKey(props) ?? "onShowTab"] = plan.onShow;
  return next;
}

/** The id of the tab a tabbed page's props say is shown (the first when they
 * say nothing). */
export function shownTabId(props: any): unknown {
  const shape = findTabProp(props);
  const active = props?.[activeTabKey(props)];
  if (active !== undefined && active !== null) return active;
  return shape ? props[shape.prop][0]?.[shape.idKey] : undefined;
}

// ---- The diagnostic line (anygame.78) --------------------------------------

export interface ScreenTwoReport {
  maps: Record<string, ClassMapReport>;
  /** Which keys each map has (key names only, never the hashed classes). */
  keys: Record<string, { found: string[]; missing: string[] }>;
  coreGlobal: boolean;
  /** Tabbed page memos patched; whether @decky/ui's Tabs was among them. */
  patched: number;
  deckyTabs: boolean;
  /** Fibers readable from the scout (React's key on its element). */
  scoutFibers: boolean;
  /** Tabbed pages rendered through Forge's wrapper found in the scout's page. */
  wrappedNear: number;
  scout?: ScreenTwo;
}

/** Which of `CLASS_MAP_KEYS` a merged map carries. */
export function keyReport(maps: Record<string, ClassUnion>): Record<string, { found: string[]; missing: string[] }> {
  const out: Record<string, { found: string[]; missing: string[] }> = {};
  for (const [name, keys] of Object.entries(CLASS_MAP_KEYS)) {
    const map = maps[name] ?? {};
    out[name] = { found: keys.filter((k) => map[k]?.length), missing: keys.filter((k) => !map[k]?.length) };
  }
  return out;
}

/** One line saying what was found and what was missing, so the next log or
 * Core UI snapshot shows exactly where the way to screen two broke. */
export function screenTwoDiagnostic(r: ScreenTwoReport): string {
  const maps = Object.entries(r.maps)
    .map(([name, m]) => {
      const k = r.keys[name];
      const keys = k ? ` [${k.found.length ? `has ${k.found.join(",")}` : "no keys"}${k.missing.length ? `; missing ${k.missing.join(",")}` : ""}]` : "";
      return `${name}: ${m.modules} module${m.modules === 1 ? "" : "s"}${m.alt ? " (second key set)" : ""}${m.source.startsWith("core") ? ` (${m.source})` : ""}${keys}`;
    })
    .join("; ");
  const s = r.scout;
  const page = s
    ? `container ${s.container ? "found" : "missing"}, tab row ${s.tabRow ? "found" : "missing"}, tabbed page ${s.tabbedPage ? "found" : "missing"}, section list ${s.sections ? "found" : "missing"}, path to tabs ${s.tabPath ? "yes" : "no"}, path to cards ${s.sectionPath || s.contentPath ? "yes" : "no"}`
    : "scout did not run";
  return (
    `Forge game page: Mods not shown, nothing drawn. Class maps: ${maps}. ` +
    `Core class maps on window: ${r.coreGlobal ? "yes" : "no"}. ` +
    `Tabbed page components patched: ${r.patched}${r.deckyTabs ? " (incl. @decky/ui Tabs)" : " (@decky/ui Tabs missing)"}. ` +
    `Scout fibers: ${r.scoutFibers ? "yes" : "no"}; patched tabbed pages on this page: ${r.wrappedNear}. ` +
    `Screen two: ${page}.`
  );
}
