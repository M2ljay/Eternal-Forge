// Forge on The Collector's ROM pages (eternal-romm), frontend only.
//
// The Collector draws ROM pages itself (it replaces Steam's overview panel)
// and offers two versioned globals:
//
//   window.__eternalGamePage      register a tab / overview card on its page
//   window.__eternalCollectorMods the emulator side of modding: targets,
//                                 Downloads sources, preview, install, remove
//
// Forge registers `forge.mods` as a tab and as an overview card when the
// first global appears (plugins load in any order, so it is polled for), and
// unregisters on unload. Installing never hands The Collector a path: Forge's
// backend puts the download at the top of the Downloads folder The Collector
// lists, and the frontend passes only that entry's NAME and a target id.
//
// No imports: the node tests compile this file standalone
// (pnpm run test:collector).

export const GAME_PAGE_VERSION = 1;
export const COLLECTOR_MODS_VERSION = 1;
/** The tab's id. While an extension with exactly this id is registered, The
 * Collector hides its own Mods button (the tab takes its place). */
export const FORGE_EXT_ID = "forge.mods";
/** The Overview card's id: ids are unique across kinds, and registering an
 * id again replaces the earlier registration. */
export const FORGE_CARD_ID = "forge.mods.card";
/** Fired on window each time The Collector installs its globals; a reloaded
 * Collector starts from an empty registry, so Forge registers again. */
export const GAME_PAGE_READY_EVENT = "eternal_game_page_ready";
export const COLLECTOR_MODS_READY_EVENT = "eternal_collector_mods_ready";

export interface RomPageContext {
  appId: number;
  romId: number;
  name: string;
  platformSlug: string;
  platformName: string;
  installed: boolean;
  locale: string;
  /** Switches the page to a registered extension's tab (by its id). Optional
   * in the contract: without it the card opens the tab's content in a modal. */
  openTab?: (extensionId: string) => void;
}

export interface GamePageExtension {
  id: string;
  kind: "tab" | "overviewCard";
  label: string | ((locale: string) => string);
  order?: number;
  isAvailable?: (ctx: RomPageContext) => boolean;
  render: (ctx: RomPageContext) => unknown;
  subscribe?: (listener: () => void) => () => void;
}

export interface GamePageApi {
  version: number;
  register(ext: GamePageExtension): () => void;
  list?(): unknown[];
}

/** The Collector's answers keep its own wire shape: `{success, reason,
 * message}` on failure. `ok` is accepted too, in case the bridge maps it. */
export interface BridgeFailure {
  success?: false;
  ok?: false;
  reason?: string;
  message?: string;
  error?: string;
}

export interface ModEntry {
  name: string;
  is_dir?: boolean;
  size?: number | null;
  modified?: number;
}

export interface ModTarget {
  target_id: string;
  label: string;
  scope?: string;
  exists?: boolean;
  notes?: string[];
  installed?: ModEntry[];
  accepts?: "patch" | "archive_or_folder" | string;
  setting?: { label: string; state: string; can_enable: boolean } | null;
}

export interface ModSource extends ModEntry {
  kind?: "zip" | "folder" | "patch" | "unsupported_archive" | string;
  supported?: boolean;
}

export interface ModPreview {
  success?: true;
  ok?: true;
  destination?: string;
  source?: string;
  writes?: { path: string; size: number; replaces: boolean }[];
  write_count?: number;
  total_bytes?: number;
  replace_count?: number;
  stripped_folder?: string | null;
  backup_root?: string | null;
  fingerprint: string;
}

export interface CollectorModsApi {
  version: number;
  isRomApp(appId: number): boolean | Promise<boolean>;
  getRomInfo?(appId: number): unknown;
  getTargets(appId: number): Promise<any>;
  /** Filtered by target (a soft-patch target lists only patch files); without
   * one, The Collector lists for the game's first target. */
  listSources(appId: number, targetId?: string): Promise<any>;
  preview(appId: number, source: string, targetId: string): Promise<any>;
  install(appId: number, source: string, targetId: string, fingerprint: string): Promise<any>;
  listInstalled?(appId: number, targetId: string): Promise<any>;
  remove?(appId: number, targetId: string, entryName: string | null): Promise<any>;
  readSetting?(appId: number, targetId: string): Promise<any>;
  enableSetting?(appId: number, targetId: string): Promise<any>;
  openFolder?(appId: number, targetId: string): Promise<any>;
}

type Win = Record<string, any> | undefined;

/** The game-page API when it is there and speaks version 1. */
export function readGamePage(win: Win): GamePageApi | undefined {
  try {
    const api = win?.__eternalGamePage;
    if (api && api.version === GAME_PAGE_VERSION && typeof api.register === "function") return api;
  } catch {
    // a hostile getter: treat as absent
  }
  return undefined;
}

/** The mods bridge when it is there and speaks version 1. */
export function readCollectorMods(win: Win): CollectorModsApi | undefined {
  try {
    const api = win?.__eternalCollectorMods;
    if (api && api.version === COLLECTOR_MODS_VERSION && typeof api.preview === "function"
      && typeof api.install === "function") return api;
  } catch {
    // absent
  }
  return undefined;
}

export function isOk(ans: any): boolean {
  return Boolean(ans) && (ans.success === true || ans.ok === true);
}

/** A failure's reason and message, as The Collector worded it. */
export function failure(ans: any, fallback = "The Collector refused"): { reason: string; message: string } {
  return {
    reason: String(ans?.reason ?? (ans ? "refused" : "no_answer")),
    message: String(ans?.message ?? ans?.error ?? fallback),
  };
}

// ---- Registration ------------------------------------------------------------

export interface WatchDeps {
  getWin: () => Win;
  exts: () => GamePageExtension[];
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  log?: (message: string) => void;
  /** How often to look for the global (and for The Collector reloading). */
  pollMs?: number;
  /** Subscribes to a window event; returns the unsubscribe. */
  listen?: (event: string, fn: () => void) => () => void;
}

export interface Watcher {
  stop(): void;
  /** "waiting" (no global yet), "registered", "stopped". */
  state(): "waiting" | "registered" | "stopped";
}

/** Registers Forge's extensions on The Collector's game page as soon as its
 * global is there, and again if The Collector reloads (a new global object).
 * When the global never appears (an old Collector), nothing happens and the
 * Steam route patch keeps today's behaviour. stop() unregisters everything. */
export function watchGamePage(d: WatchDeps): Watcher {
  const pollMs = d.pollMs ?? 2000;
  let api: GamePageApi | undefined;
  let undo: (() => void)[] = [];
  let stopped = false;
  let timer: unknown;
  const log = (m: string) => {
    try {
      d.log?.(m);
    } catch {
      // logging never breaks registration
    }
  };
  const unregisterAll = () => {
    for (const u of undo) {
      try {
        u();
      } catch {
        // The Collector may already be gone
      }
    }
    undo = [];
  };
  const check = (force = false) => {
    if (stopped) return;
    const now = readGamePage(d.getWin());
    if (now && (now !== api || force)) {
      unregisterAll();
      api = now;
      for (const ext of d.exts()) {
        try {
          const u = now.register(ext);
          if (typeof u === "function") undo.push(u);
        } catch (e) {
          log(`Forge: The Collector refused ${ext.id} (${ext.kind}): ${String(e)}`);
        }
      }
      log(`Forge: registered on The Collector's game page (${undo.length} extensions)`);
    } else if (!now && api) {
      // The Collector unloaded: its page and our registrations are gone.
      undo = [];
      api = undefined;
    }
    if (!force) timer = d.setTimer(() => check(), pollMs);
  };
  check();
  // The Collector's ready event: register again at once (its registry may be
  // a fresh, empty one even when the poll has not noticed yet).
  let unlisten: (() => void) | undefined;
  try {
    unlisten = d.listen?.(GAME_PAGE_READY_EVENT, () => check(true));
  } catch {
    unlisten = undefined;
  }
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) d.clearTimer(timer);
      try {
        unlisten?.();
      } catch {
        // already gone
      }
      unregisterAll();
      api = undefined;
    },
    state() {
      return stopped ? "stopped" : api ? "registered" : "waiting";
    },
  };
}

/** True when the Steam route patch should leave a Collector page alone: The
 * Collector draws it, and Forge is (or will be) on it through the game-page
 * API. Without the API (an old Collector) the page is skipped as before. */
export function collectorPageHandled(win: Win): boolean {
  return Boolean(readGamePage(win));
}

// ---- Targets and sources -------------------------------------------------------

/** Targets a file of this kind can go to: a bare soft patch only to patch
 * targets, a folder only to the others, and a .zip to either (The Collector
 * takes a .zip holding exactly one patch for a soft patch, and refuses any
 * other in its preview). */
export function targetsFor(targets: ModTarget[], kind: "patch" | "zip" | "folder" | string): ModTarget[] {
  if (kind === "zip") return [...(targets ?? [])];
  const patch = kind === "patch";
  return (targets ?? []).filter((t) => (t.accepts === "patch") === patch);
}

/** The kind a downloaded file will be staged as (same rule as the backend's
 * rom_mods.stage_kind). */
export function fileKind(fileName: string): "zip" | "patch" | "folder" {
  const ext = (fileName.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
  if (ext === ".zip") return "zip";
  if (ext === ".ips" || ext === ".bps" || ext === ".ups") return "patch";
  return "folder";
}

/** Entry names installed in one target, from a getTargets answer. */
export function installedNames(targetsAnswer: any, targetId: string): string[] {
  const t = (targetsAnswer?.targets ?? []).find((x: ModTarget) => x?.target_id === targetId);
  return (t?.installed ?? []).map((e: ModEntry) => String(e?.name ?? "")).filter(Boolean);
}

export function newEntries(before: string[], after: string[]): string[] {
  const seen = new Set(before.map((n) => n.toLowerCase()));
  return after.filter((n) => !seen.has(n.toLowerCase()));
}

/** A name is a single Downloads entry or installed entry: never a path. */
export function isEntryName(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && !/[\\/:\x00]/.test(name) && name === name.trim();
}

// ---- The install flow ------------------------------------------------------------

export type RomSource = "gamebanana" | "nexus" | "local";

/** How often a "changed" install answer leads to a fresh preview. */
export const MAX_REPREVIEWS = 2;

export interface RomModFile {
  mod_id: number;
  file_id: number;
  file_name: string;
  name: string;
  version?: string;
  date?: number;
  domain?: string;
}

export interface RomInstallArgs {
  appId: number;
  romId?: number;
  source: RomSource;
  /** GameBanana / Nexus: the file to download. */
  file?: RomModFile;
  /** Local: the Downloads entry the user picked (from listSources). */
  entry?: string;
  target: { target_id: string; label: string };
  /** An update: the entries the old file added, kept on the record when the
   * new file writes the same names again. */
  keepEntries?: string[];
}

/** Top-level names a preview writes, from its relative write paths (an
 * absolute path is read relative to the preview's destination). */
export function entriesFromPreview(p: ModPreview | undefined): string[] {
  const out: string[] = [];
  const dest = String(p?.destination ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  for (const w of p?.writes ?? []) {
    let path = String(w?.path ?? "").replace(/\\/g, "/");
    if (/^([A-Za-z]:\/|\/)/.test(path)) {
      if (!dest || !path.toLowerCase().startsWith(dest + "/")) continue;
      path = path.slice(dest.length + 1);
    }
    const first = path.split("/").filter(Boolean)[0];
    if (first && !out.some((n) => n.toLowerCase() === first.toLowerCase())) out.push(first);
  }
  return out;
}

export interface RomInstallDeps {
  bridge: CollectorModsApi;
  /** Backend: download and stage into Downloads; returns the entry name. */
  stage: (file: RomModFile, source: RomSource, folder: string) => Promise<{ ok: boolean; entry?: string; error?: string }>;
  unstage: (entry: string, folder: string) => Promise<unknown>;
  record: (rec: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  /** Shows The Collector's preview; resolves true to install. */
  confirm: (preview: ModPreview, entry: string) => Promise<boolean>;
}

export type RomInstallResult =
  | { ok: true; entry: string; entries: string[]; written: number; backedUp: number; backupFolder: string | null }
  | { ok: false; step: "sources" | "download" | "preview" | "cancelled" | "install" | "record"; reason: string; message: string };

/** Download (GameBanana/Nexus) into Downloads, show The Collector's preview,
 * install only after the user confirms it, then record what was added. A
 * refusal at any step comes back with The Collector's own reason and message.
 * Entries Forge staged are taken away again on every exit except a
 * successful install's own record failing (the mod is in; the entry is
 * removed too, the archive stays in Forge's cache). */
export async function runRomInstall(d: RomInstallDeps, a: RomInstallArgs): Promise<RomInstallResult> {
  const { bridge } = d;
  const target = a.target.target_id;
  const sources = await bridge.listSources(a.appId, target);
  if (!isOk(sources)) return { ok: false, step: "sources", ...failure(sources, "The Collector could not read Downloads") };
  const folder = String(sources.folder ?? "");
  let entry = a.entry ?? "";
  let staged = false;
  if (a.source !== "local") {
    if (!a.file) return { ok: false, step: "download", reason: "no_file", message: "No file picked" };
    const s = await d.stage(a.file, a.source, folder);
    if (!s.ok || !s.entry) return { ok: false, step: "download", reason: "download", message: s.error ?? "Download failed" };
    entry = s.entry;
    staged = true;
  }
  const cleanup = async () => {
    if (staged) {
      try {
        await d.unstage(entry, folder);
      } catch {
        // the entry stays in Downloads; harmless
      }
    }
  };
  if (!isEntryName(entry)) {
    await cleanup();
    return { ok: false, step: "preview", reason: "bad_entry", message: "Not a Downloads entry" };
  }
  const before = installedNames(await bridge.getTargets(a.appId).catch(() => undefined), target);
  // Preview -> show it -> install with its fingerprint. "changed" (the file
  // or the folder moved on since the preview) means: preview again and ask
  // again, a bounded number of times.
  let preview: any;
  let res: any;
  for (let round = 0; ; round++) {
    preview = await bridge.preview(a.appId, entry, target);
    if (!isOk(preview)) {
      await cleanup();
      return { ok: false, step: "preview", ...failure(preview) };
    }
    let go = false;
    try {
      go = await d.confirm(preview as ModPreview, entry);
    } catch {
      go = false;
    }
    if (!go) {
      await cleanup();
      return { ok: false, step: "cancelled", reason: "cancelled", message: "Not installed" };
    }
    res = await bridge.install(a.appId, entry, target, String((preview as ModPreview).fingerprint ?? ""));
    if (isOk(res)) break;
    if (res?.reason === "changed" && round < MAX_REPREVIEWS) continue;
    await cleanup();
    return { ok: false, step: "install", ...failure(res) };
  }
  const after = installedNames(await bridge.getTargets(a.appId).catch(() => undefined), target);
  // What the install added, plus what it wrote again (a texture folder that
  // was already there; an update's own files), as long as The Collector
  // lists it: only names it listed are ever handed back to its remove.
  const listed = new Set(after.map((n) => n.toLowerCase()));
  const added: string[] = [];
  for (const n of [...newEntries(before, after), ...entriesFromPreview(preview as ModPreview), ...(a.keepEntries ?? [])]) {
    if (isEntryName(n) && listed.has(n.toLowerCase()) && !added.some((x) => x.toLowerCase() === n.toLowerCase())) added.push(n);
  }
  const rec = await d.record({
    source: a.source,
    mod_id: a.file?.mod_id ?? 0,
    file_id: a.file?.file_id ?? 0,
    file_name: a.file?.file_name ?? entry,
    file_date: a.file?.date ?? 0,
    name: a.file?.name ?? entry,
    version: a.file?.version ?? "",
    domain: a.file?.domain ?? "",
    target_id: target,
    target_label: a.target.label,
    entries: added,
    rom_id: a.romId ?? 0,
  });
  await cleanup();
  if (!rec.ok) return { ok: false, step: "record", reason: "record", message: rec.error ?? "Installed, but Forge could not remember it" };
  return {
    ok: true,
    entry,
    entries: added,
    written: Number(res.written ?? 0),
    backedUp: Number(res.backed_up ?? 0),
    backupFolder: res.backup_folder ?? null,
  };
}

export interface RomRecordLike {
  id: string;
  target_id: string;
  entries: string[];
}

/** Removes a Forge-installed ROM mod through The Collector (which backs every
 * entry up) and forgets the record once every entry went. Entries are
 * names The Collector listed, never paths. A record with no known entries
 * (a soft patch replaced in place) is refused rather than removing the
 * whole target. */
export async function runRomRemove(
  bridge: CollectorModsApi,
  appId: number,
  rec: RomRecordLike,
  forget: (id: string) => Promise<unknown>
): Promise<{ ok: boolean; removed: string[]; message: string; backupFolder?: string }> {
  if (typeof bridge.remove !== "function") {
    return { ok: false, removed: [], message: "This version of The Collector cannot remove mods for Forge yet." };
  }
  const entries = (rec.entries ?? []).filter(isEntryName);
  if (!entries.length) {
    return { ok: false, removed: [], message: "Forge doesn't know which files this mod added. Remove it in The Collector's Mods panel." };
  }
  const removed: string[] = [];
  let backupFolder: string | undefined;
  for (const name of entries) {
    const r = await bridge.remove(appId, rec.target_id, name);
    if (!isOk(r)) {
      const f = failure(r);
      return { ok: false, removed, message: f.message };
    }
    removed.push(name);
    backupFolder = r.backup_folder ?? backupFolder;
  }
  await forget(rec.id);
  return { ok: true, removed, message: "Moved to The Collector's backup folder", backupFolder };
}

// ---- The ROM card ----------------------------------------------------------------

export interface RomCardSummary {
  active: number;
  updates: number;
  status: { text: string; tone: "ok" | "warn" | "error" | "hint" };
}

/** The ROM page's Overview card: Forge's mod count, updates, and one status
 * line from The Collector's targets answer. */
export function romCardSummary(o: {
  installed: boolean;
  records: { id: string }[];
  updates: number;
  targets?: any;
  bridge: boolean;
}): RomCardSummary {
  const active = o.records.length;
  const updates = Math.max(0, o.updates);
  const status = ((): RomCardSummary["status"] => {
    if (!o.bridge) return { text: "Update The Collector to mod ROMs with Forge", tone: "hint" };
    if (!o.installed) return { text: "Install the game to add mods", tone: "hint" };
    if (o.targets === undefined) return { text: "Reading...", tone: "hint" };
    if (!isOk(o.targets)) return { text: failure(o.targets, "No mod folder").message, tone: "warn" };
    const targets: ModTarget[] = o.targets.targets ?? [];
    if (!targets.length) return { text: o.targets.note || "No known mod folder for this emulator", tone: "warn" };
    const off = targets.find((t) => t.setting && t.setting.state === "off");
    if (off?.setting) return { text: `${off.setting.label} is off`, tone: "warn" };
    const emu = o.targets.emulator?.label;
    if (updates) return { text: "Updates waiting", tone: "warn" };
    return { text: emu ? `Ready · ${emu}` : "Ready", tone: "ok" };
  })();
  return { active, updates, status };
}
