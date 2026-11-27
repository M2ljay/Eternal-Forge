// Forge rules that do not need Steam or the backend: what the game page's
// Mods section shows, the tile-dot stylesheet, and the patch's failure
// budget. Self-contained on purpose (no imports) so tests/forge.test.mjs
// compiles this one file and checks it under node.

/** Forge palette: AMOLED black, crimson for accents and problems, steel
 * for secondary text, gunmetal surfaces. No glow, no haze. Copies of the
 * Core tokens in palette.ts, kept here because this file compiles alone;
 * tests/forge.test.mjs fails if they drift. */
export const FORGE_BLACK = "#000000";
export const FORGE_CRIMSON = "#D7263D";
export const FORGE_STEEL = "#C9D1D9";
export const FORGE_GUNMETAL = "#1A1D21";

// ---- Patch failure budget ----------------------------------------------------
// The game page is Steam's, not ours. Any error in the patch or in the
// section leaves the page as Steam drew it, and after this many in one
// session the patch stops trying until the plugin reloads.
export const PATCH_FAILURE_LIMIT = 3;

export class FailureBudget {
  private failures = 0;
  constructor(private readonly limit: number = PATCH_FAILURE_LIMIT) {}
  /** Count one failure; true when that one used the budget up. */
  fail(): boolean {
    this.failures += 1;
    return this.failures === this.limit;
  }
  get disabled(): boolean {
    return this.failures >= this.limit;
  }
  get count(): number {
    return this.failures;
  }
}

// ---- What the section shows --------------------------------------------------

export type SectionMode = "hidden" | "locked" | "setup" | "mods";

export function sectionMode(o: {
  managed: boolean;
  locked: boolean;
  experimental: boolean;
  enabledSetting: boolean;
}): SectionMode {
  if (!o.enabledSetting) return "hidden";
  // A locked game says so even when the plugin does not manage it: that is
  // the moment someone is about to mod it some other way.
  if (o.locked) return "locked";
  if (o.managed) return "mods";
  // Every game in the library is offered setup (anygame.72): the setup flow
  // switches the any-game mode on itself, so `experimental` no longer hides
  // the card.
  return "setup";
}

export interface ModLike {
  folder: string;
  enabled: boolean;
  togglable?: boolean;
}

/** The {folder: on} set the crash guard compares. Mods without a switch
 * are left out: nothing can restore them, so they cannot be blamed. */
export function modSet(mods: ModLike[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of mods) {
    if (m.togglable === false) continue;
    out[m.folder] = Boolean(m.enabled);
  }
  return out;
}

/** Rows shown on the game page before "Show all": enough to see what is
 * going on, few enough that Play stays one or two presses away. Mods with
 * an update and mods that are on come first. */
export const GAME_PAGE_ROWS = 6;

export function rowsToShow<T extends ModLike>(
  mods: T[],
  updates: Set<string>,
  limit = GAME_PAGE_ROWS
): T[] {
  const rank = (m: T) => (updates.has(m.folder) ? 0 : m.enabled ? 1 : 2);
  return [...mods]
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, Math.max(0, limit));
}

export function countLabel(mods: ModLike[]): string {
  const on = mods.filter((m) => m.enabled).length;
  if (mods.length === 0) return "No mods installed";
  return `${on} of ${mods.length} on`;
}

export interface AntiCheatVerdict {
  detected: boolean;
  locked: boolean;
  products: string[];
  source: string;
  marker?: string;
  name?: string;
  override_allowed: boolean;
  override_on: boolean;
  offline_note?: string;
  /** "offline": the game can be played modded without its anti-cheat;
   * "ban": online-only or unknown, a modded game risks the account. */
  risk?: "offline" | "ban";
  online_only?: boolean;
}

/** The bypass is one press, no dialog, so the button itself has to carry
 * the risk in plain words. */
export function overrideLabel(v: AntiCheatVerdict): string {
  return v.risk === "offline"
    ? "Allow mods anyway - play modded offline only"
    : "Allow mods anyway - may get this account banned";
}

export function lockHeadline(v: AntiCheatVerdict): string {
  const what = v.products.length ? v.products.join(" + ") : "anti-cheat";
  return `Mods locked - ${what}`;
}

export function lockBody(v: AntiCheatVerdict): string {
  const why =
    v.source === "folder"
      ? `Anti-cheat files are in the game folder (${v.marker || "found"}).`
      : "This game is known to run anti-cheat on your PC.";
  const risk =
    v.risk === "offline"
      ? "This game has an offline or anti-cheat-off mode; mods are only safe there, never online."
      : "A modded copy of this game can get the account banned, whatever the mod does.";
  return (
    `${why} Installing or switching on mods is off for this game to protect your ` +
    `account. ${risk} Switching mods off still works.`
  );
}

export interface RestorePlan {
  changes: { folder: string; enabled: boolean }[];
  missing: string[];
  lkg_at: number;
  vanilla: boolean;
}

export function offerBody(plan: RestorePlan, names: Record<string, string> = {}): string {
  const off = plan.changes.filter((c) => !c.enabled);
  const on = plan.changes.filter((c) => c.enabled);
  const label = (f: string) => names[f] ?? f;
  const parts: string[] = [];
  if (off.length) parts.push(`switch off ${off.length} (${off.slice(0, 3).map((c) => label(c.folder)).join(", ")}${off.length > 3 ? ", ..." : ""})`);
  if (on.length) parts.push(`switch back on ${on.length}`);
  const target = plan.vanilla
    ? "There is no clean run on record, so this switches every mod off."
    : `Back to the mods of the last run that worked${plan.lkg_at ? ` (${new Date(plan.lkg_at * 1000).toLocaleDateString()})` : ""}.`;
  const what = parts.length ? ` It will ${parts.join(" and ")}.` : " Nothing needs switching.";
  const gone = plan.missing.length
    ? ` ${plan.missing.length} mod${plan.missing.length === 1 ? " was" : "s were"} removed since and stay${plan.missing.length === 1 ? "s" : ""} removed.`
    : "";
  return `${target}${what}${gone} Nothing is deleted, and it can be undone.`;
}

// ---- Tile dots ---------------------------------------------------------------
// One stylesheet in Steam's main window. Pure CSS on purpose: a selector
// that matches nothing does nothing, so a Steam update that renames its
// markup removes the dots and never breaks a tile. The capsule <img> carries
// the app id in its URL (library_600x900 for portraits, <appid>p.<ext> for
// custom art); :has() puts the dot on the image's wrapper.

export const DOT_STYLE_ID = "forge-update-dots";

export function dotCss(appIds: number[]): string {
  const ids = [...new Set(appIds.filter((a) => Number.isInteger(a) && a > 0))].sort(
    (a, b) => a - b
  );
  if (ids.length === 0) return "";
  const imgs = ids
    .flatMap((id) => [
      `img[src*="/${id}/library_600x900"]`,
      `img[src*="/${id}/library_capsule"]`,
      `img[src*="/${id}p."]`,
    ])
    .join(",");
  return (
    `:is(div):has(> :is(${imgs}))::after{` +
    'content:"";position:absolute;top:8px;right:8px;width:12px;height:12px;' +
    `border-radius:50%;background:${FORGE_CRIMSON};border:2px solid ${FORGE_BLACK};` +
    "z-index:5;pointer-events:none;box-sizing:border-box;}"
  );
}

/** App ids whose game has at least one mod update waiting. */
export function appsWithUpdates(
  games: { appId: number; nexusDomain: string }[],
  counts: Record<string, { count: number }>
): number[] {
  return games
    .filter((g) => (counts[g.nexusDomain]?.count ?? 0) > 0)
    .map((g) => g.appId);
}

// ---- Crash guard toast ---------------------------------------------------------

export function offerToast(gameName: string): { title: string; body: string } {
  return {
    title: "Restore last working mods?",
    body: `${gameName} closed early twice since its mods changed. Open its page to go back - nothing is deleted.`,
  };
}

// ---- Undo after a restore ------------------------------------------------------

/** What an undo of "Restore last working mods" leaves behind. The record of
 * the set that was on before the restore is cleared only when every change
 * went through: if any was refused (an anti-cheat lock, a busy folder) the
 * record stays, so Undo can be tried again. Retrying switches only what still
 * differs, because the backend plans from the record against the current set. */
export function undoOutcome(failed: string[]): { clearRecord: boolean; title: string; body: string } {
  if (!failed.length) {
    return { clearRecord: true, title: "Mods put back as they were", body: "" };
  }
  const more = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";
  return {
    clearRecord: false,
    title: `Undo incomplete: ${failed.length} mod${failed.length === 1 ? "" : "s"} not restored`,
    body: `${failed.slice(0, 3).join("; ")}${more}. Undo stays on the game page to try again.`,
  };
}

// ---- Save backups (Ludusavi) ---------------------------------------------------
// Ludusavi is optional. Without it the game page says nothing about saves and
// Settings shows one calm line; with it, the backend backs a game's saves up
// before mods go in or on (skipped within the window), and the game page shows
// when that last worked and offers "Restore saves...".

export const SAVE_BACKUP_HINT = "Install Ludusavi to back up saves before mod changes";

export interface SaveBackupGame {
  last_backup_at: number;
  last_at: number;
  last_ok: boolean;
  last_error: string;
  title?: string;
}

/** "just now", "12 min ago", "3 h ago", "yesterday", "5 days ago". */
export function backupAge(at: number, now: number): string {
  const s = Math.max(0, Math.floor(now - at));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The game page's save line: null when Ludusavi is not installed (the
 * page stays quiet about saves). failed: the latest attempt did not work,
 * shown as a small note under the line. */
export function saveBackupLine(
  found: boolean,
  game: SaveBackupGame | undefined,
  now: number
): { text: string; failed: string } | null {
  if (!found) return null;
  const g = game ?? { last_backup_at: 0, last_at: 0, last_ok: false, last_error: "" };
  const text = g.last_backup_at
    ? `Last save backup: ${backupAge(g.last_backup_at, now)}`
    : "No save backup yet";
  const failedLatest = g.last_at > 0 && !g.last_ok && g.last_at >= g.last_backup_at;
  return { text, failed: failedLatest ? "Save backup failed" : "" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One of Ludusavi's backups in the Restore list: local date and time, age,
 * then its comment and lock as Ludusavi shows them. */
export function backupRowLabel(
  b: { at: number; when?: string; comment?: string; locked?: boolean },
  now: number
): string {
  let label: string;
  if (b.at > 0) {
    const d = new Date(b.at * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    label = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm} (${backupAge(b.at, now)})`;
  } else {
    label = b.when || "Unknown date";
  }
  if (b.comment) label += ` - ${b.comment}`;
  if (b.locked) label += " - kept";
  return label;
}

export function restoreConfirmBody(gameName: string, rowLabel: string): string {
  return (
    `Forge first backs up ${gameName}'s current saves with Ludusavi, then puts back the backup from ` +
    `${rowLabel}. If the first backup fails, nothing is restored. Close the game before restoring.`
  );
}

/** The small note when a backup before a mod change did not work. The mod
 * change itself went ahead. */
export function backupFailToast(error: string): { title: string; body: string } {
  const detail = (error || "").trim();
  return {
    title: "Save backup failed",
    body: `${detail ? detail.replace(/\.?$/, ".") + " " : ""}The mod change went ahead.`,
  };
}

/** Settings row text for the skip window. */
export function skipWindowLabel(minutes: number): string {
  if (minutes <= 0) return "Back up before every mod change";
  return `At most one backup per game every ${minutes} min`;
}

// ---- OptiScaler (game page "Upscaling" entry) --------------------------------

/** Shown in crimson, with no override, for every game OptiScaler is refused
 * for. Must match py_modules/optiscaler.py REFUSED_TEXT. */
export const OPTISCALER_REFUSED = "Not allowed: anti-cheat (DLL injection)";

export interface OptiScalerLineInput {
  allowed: boolean;
  installed: { installed: boolean; upscaler_label?: string; proxy?: string; version?: string;
    suspect?: { kind: string } | null };
  update_available?: boolean;
  latest?: string;
}

/** The entry's one line and its tone: "refused" (crimson, no buttons but
 * Remove if it is somehow in), "suspect" (crimson box, one-press removal),
 * "installed", or "off". */
export function optiscalerLine(s: OptiScalerLineInput): { tone: "refused" | "suspect" | "installed" | "off"; text: string } {
  const inst = s.installed;
  if (!s.allowed) return { tone: "refused", text: OPTISCALER_REFUSED };
  if (inst.installed && inst.suspect) {
    return {
      tone: "suspect",
      text:
        inst.suspect.kind === "crash"
          ? "The game crashed after OptiScaler was added."
          : "The game closed within a minute after OptiScaler was added.",
    };
  }
  if (inst.installed) {
    const parts = [inst.upscaler_label || "Upscaler", `as ${inst.proxy}`];
    if (inst.version) parts.push(inst.version);
    let text = parts.join(" - ");
    if (s.update_available && s.latest) text += ` (update: ${s.latest})`;
    return { tone: "installed", text };
  }
  return { tone: "off", text: "Not installed. Swaps the game's upscaler for FSR 4, FSR 3.1, XeSS or DLSS." };
}

// ---- Load order (LOOT rules) and deploy profiles -------------------------------
// The game page's Load order entry and panel, for the Bethesda games whose load
// order is a text file. The backend (py_modules/load_order.py) does the sorting.

/** Skyrim SE, Fallout 4, Starfield, Oblivion Remastered (Steam app ids). */
export const LOAD_ORDER_APP_IDS = [489830, 377160, 1716740, 2623190];
export const LOAD_ORDER_DOMAINS = ["skyrimspecialedition", "fallout4", "starfield", "oblivionremastered"];

export function loadOrderSupported(appId: number, domain?: string): boolean {
  return LOAD_ORDER_APP_IDS.includes(Number(appId)) || LOAD_ORDER_DOMAINS.includes(domain ?? "");
}

export interface LoWarningLike {
  plugin: string;
  level: "error" | "warn";
  text: string;
}

/** The worst warning of a plugin, for its row: errors (crimson) before
 * warnings (amber). */
export function firstWarning(ws?: LoWarningLike[]): LoWarningLike | undefined {
  if (!ws || ws.length === 0) return undefined;
  return ws.find((w) => w.level === "error") ?? ws[0];
}

/** The one line the game page shows about problems. */
export function warningSummary(counts?: { error: number; warn: number }): { tone: "error" | "warn" | "ok"; text: string } {
  const e = counts?.error ?? 0;
  const w = counts?.warn ?? 0;
  if (!e && !w) return { tone: "ok", text: "No problems found" };
  const parts: string[] = [];
  if (e) parts.push(`${e} problem${e === 1 ? "" : "s"}`);
  if (w) parts.push(`${w} warning${w === 1 ? "" : "s"}`);
  return { tone: e ? "error" : "warn", text: parts.join(", ") };
}

export interface MasterlistLike {
  available: boolean;
  fetched_at: number;
  error: string;
}

/** Where the sorting rules come from, in one line. */
export function masterlistLine(m: MasterlistLike | undefined, now: number): string {
  if (!m || !m.available) {
    return m?.error
      ? "LOOT masterlist not downloaded yet (offline?): sorting by masters and plugin flags only"
      : "LOOT masterlist not downloaded yet: sorting by masters and plugin flags only";
  }
  const age = m.fetched_at ? backupAge(m.fetched_at, now) : "a while ago";
  return `LOOT masterlist, updated ${age}` + (m.error ? " (offline: using the saved copy)" : "");
}

/** The toast after "Sort with LOOT rules". */
export function sortOutcome(r: {
  ok: boolean;
  error?: string;
  moved?: number;
  notes?: string[];
  cycle?: string[];
  masterlist_used?: boolean;
}): { title: string; body: string } {
  if (r.cycle && r.cycle.length) {
    return { title: "Not sorted: rules go in a circle", body: r.error ?? r.cycle.join(" -> ") };
  }
  if (!r.ok) return { title: "Could not sort", body: r.error ?? "" };
  const notes = (r.notes ?? []).slice(0, 2).join(" ");
  const source = r.masterlist_used ? "LOOT's rules" : "masters and plugin flags (no masterlist yet)";
  if (!r.moved) return { title: "Already in order", body: (`Nothing to move by ${source}. ` + notes).trim() };
  return {
    title: `Sorted: ${r.moved} plugin${r.moved === 1 ? "" : "s"} moved`,
    body: (`By ${source}. Undo is on the Load order page. ` + notes).trim(),
  };
}

/** "" when a profile switch may start, else why not. */
export function profileSwitchBlocked(runningAppId: number | undefined, appId: number, busy = false): string {
  if (busy) return "Another change is still running.";
  if (runningAppId && Number(runningAppId) === Number(appId)) {
    return "Close the game first: profiles can't be switched while it runs.";
  }
  return "";
}

/** The toast after a profile switch. */
export function profileSwitchSummary(
  name: string,
  plan: { changes?: { folder: string; enabled: boolean }[]; missing?: string[]; new_off?: string[] },
  failed: string[],
  orderOk: boolean,
  notes: string[] = []
): { title: string; body: string } {
  const changes = plan.changes ?? [];
  const on = changes.filter((c) => c.enabled).length;
  const off = changes.length - on;
  const bits: string[] = [];
  if (on || off) bits.push(`${on} mod${on === 1 ? "" : "s"} on, ${off} off.`);
  else bits.push("No mods to switch.");
  if ((plan.missing ?? []).length) bits.push(`Not installed any more: ${plan.missing!.slice(0, 3).join(", ")}.`);
  if ((plan.new_off ?? []).length) bits.push(`New since the profile was saved, left off: ${plan.new_off!.length}.`);
  if (failed.length) bits.push(`Could not switch: ${failed.slice(0, 2).join("; ")}.`);
  if (!orderOk) bits.push("The load order was not written.");
  if (notes.length) bits.push(notes[0]);
  const clean = failed.length === 0 && orderOk;
  return { title: clean ? `Profile: ${name}` : `Profile ${name}, with problems`, body: bits.join(" ") };
}

// ---- Compact game page card ----------------------------------------------------
// The Mods section sits under Steam's Play bar as one row (ROW_HEIGHT tall,
// gunmetal, a thin crimson bar on the left): "Mods", one or two status chips,
// the last save backup as a hint, and at most two buttons. A on the row
// opens the details below it; long explanations sit behind "Why?" in a small
// modal. The anti-cheat override exists only in that modal.

export const ROW_HEIGHT = 56;
/** Pixel sizes at 1080p, matched to Steam's game-page meta text. */
export const CARD_TEXT = { title: 18, body: 16, button: 15, hint: 14 } as const;
export const CARD_MAX_BUTTONS = 2;

export type CardPlacement = "below" | "above";
export type ChipTone = "crimson" | "steel" | "amber" | "hint";
export interface CardChip {
  text: string;
  tone: ChipTone;
}

export interface CardInput {
  mode: SectionMode;
  managed: boolean;
  anticheat: Pick<AntiCheatVerdict, "detected" | "locked" | "products" | "override_on" | "override_allowed">;
  /** Undefined while the mod list is still being read. */
  mods?: ModLike[];
  updates: number;
  offer: boolean;
  undo: boolean;
  /** Ludusavi is installed and knows the game. */
  savesFound: boolean;
  /** Unix seconds of the last good backup, 0 for none. */
  lastBackupAt: number;
}

/** The anti-cheat's short name for the chip: "Ricochet", "EAC + BattlEye". */
export function anticheatName(products: string[]): string {
  return products.length ? products.join(" + ") : "anti-cheat";
}

/** One or two chips, most important first: the lock, then updates, then the
 * mod count. */
export function statusChips(c: CardInput): CardChip[] {
  const out: CardChip[] = [];
  const ac = c.anticheat;
  if (c.mode === "locked") out.push({ text: `Locked · ${anticheatName(ac.products)}`, tone: "crimson" });
  else if (ac.detected && ac.override_on) out.push({ text: "Lock off", tone: "crimson" });
  if (c.mode === "setup") out.push({ text: "Not set up", tone: "hint" });
  if (c.offer && c.mode === "mods") out.push({ text: "Restore offered", tone: "amber" });
  if (c.mode === "mods" && c.updates > 0) out.push({ text: `Updates ${c.updates}`, tone: "amber" });
  if (c.mode === "mods" || (c.mode === "locked" && c.managed)) {
    const list = c.mods;
    if (!list) out.push({ text: "Reading...", tone: "hint" });
    else if (list.length === 0) out.push({ text: "Not modded", tone: "hint" });
    else {
      const on = list.filter((m) => m.enabled).length;
      out.push(on ? { text: `${on} enabled`, tone: "steel" } : { text: `All ${list.length} off`, tone: "hint" });
    }
  }
  return out.slice(0, 2);
}

/** The save hint on the row: null without Ludusavi. */
export function savesHint(found: boolean, lastBackupAt: number, now: number): string | null {
  if (!found) return null;
  return lastBackupAt > 0 ? `Saves backed up ${backupAge(lastBackupAt, now)}` : "No save backup yet";
}

export type CardAction = "restore-mods" | "undo-restore" | "mods" | "setup" | "why" | "restore-saves";

export const CARD_ACTION_LABELS: Record<CardAction, string> = {
  "restore-mods": "Restore mods...",
  "undo-restore": "Undo restore",
  mods: "Mods...",
  setup: "Set up...",
  why: "Why?",
  "restore-saves": "Restore saves...",
};

/** The row's buttons, at most CARD_MAX_BUTTONS, most relevant first: the
 * crash offer, Undo, the way to the full page (Mods..., Set up..., or Why?
 * for a locked game Forge does not manage), then Restore saves... when a
 * backup exists. Never the anti-cheat override. */
export function compactButtons(c: CardInput): CardAction[] {
  const out: CardAction[] = [];
  const locked = c.mode === "locked";
  if (c.offer && c.managed && !locked) out.push("restore-mods");
  if (c.undo && c.managed) out.push("undo-restore");
  if (c.managed) out.push("mods");
  else if (c.mode === "setup") out.push("setup");
  else if (locked) out.push("why");
  if (c.savesFound && c.lastBackupAt > 0) out.push("restore-saves");
  return out.slice(0, CARD_MAX_BUTTONS);
}

/** What A on the row does: under Play it opens the details; the one-line
 * fallback above the panel never grows, so it goes to the row's first
 * button's target instead. */
export function rowPress(placement: CardPlacement): "toggle" | "open" {
  return placement === "below" ? "toggle" : "open";
}

export type DetailLine = "lock" | "override" | "offer" | "undo" | "mods" | "saves" | "upscaling" | "loadorder" | "setup";

/** The expanded view's lines, top to bottom. Upscaling and Load order decide
 * for themselves whether they have anything to show. */
export function detailLines(c: CardInput): DetailLine[] {
  const out: DetailLine[] = [];
  const locked = c.mode === "locked";
  if (locked) out.push("lock");
  if (c.anticheat.detected && c.anticheat.override_on) out.push("override");
  if (c.offer && c.managed && !locked) out.push("offer");
  if (c.undo && c.managed) out.push("undo");
  if (c.mode === "mods" || (locked && c.managed)) out.push("mods");
  if (c.savesFound && (c.mode === "mods" || locked)) out.push("saves");
  out.push("upscaling");
  out.push("loadorder");
  if (c.mode === "setup") out.push("setup");
  return out;
}

export type LockAction = "switch-off" | "lock-again" | "why" | "allow-anyway";

/** Buttons on the expanded lock / override lines: never "allow-anyway". */
export function lockLineActions(c: { locked: boolean; managed: boolean; enabledCount: number; overrideOn: boolean }): LockAction[] {
  const out: LockAction[] = [];
  if (c.locked && c.managed && c.enabledCount > 0) out.push("switch-off");
  if (c.overrideOn) out.push("lock-again");
  out.push("why");
  return out;
}

/** The "Why?" modal's buttons: the override lives here and only here. */
export function lockModalActions(ac: Pick<AntiCheatVerdict, "locked" | "override_allowed" | "override_on">): LockAction[] {
  if (ac.locked && ac.override_allowed) return ["allow-anyway"];
  if (ac.override_on) return ["lock-again"];
  return [];
}

/** The lock line's one-line summary; lockBody is the modal's text. */
export function lockSummary(ac: Pick<AntiCheatVerdict, "products">): string {
  return `${anticheatName(ac.products)}: installing or switching mods on is off`;
}


// ---- The Overview card (anygame.72) --------------------------------------------
// On the game page, mods are a Mods tab (beside Steam's or The Collector's own
// tabs) plus a card in the Overview: the active-mod count, an amber "N
// updates" chip when updates exist, and ONE status line. X on the card opens
// the Mods tab. It replaces the row under Play; the row stays only as the
// fallback when neither the tab container nor the play section is found.

export type StatusTone = "ok" | "warn" | "error" | "hint";

export interface CardSummary {
  /** Mods switched on (always-on loose files included). */
  active: number;
  /** Pending updates; the chip shows only when > 0. */
  updates: number;
  status: { text: string; tone: StatusTone };
}

export interface CardSummaryInput {
  mode: SectionMode;
  anticheat: Pick<AntiCheatVerdict, "products" | "override_on" | "detected">;
  mods?: ModLike[];
  updates: number;
  offer: boolean;
  /** Load-order problem counts for games with a load order, else undefined. */
  loadOrder?: { error: number; warn: number };
}

/** The card's numbers and its one status line, most urgent first: the
 * anti-cheat lock, a crash restore offer, setup, reading, the load order
 * ("Load order OK"), then a plain state. */
export function cardSummary(c: CardSummaryInput): CardSummary {
  const list = c.mods ?? [];
  const active = list.filter((m) => m.enabled).length;
  const updates = c.mode === "mods" ? Math.max(0, c.updates) : 0;
  const status = ((): CardSummary["status"] => {
    if (c.mode === "locked") return { text: `Locked · ${anticheatName(c.anticheat.products)}`, tone: "error" };
    if (c.offer) return { text: "Closed early twice · restore offered", tone: "warn" };
    if (c.mode === "setup") return { text: "Not set up · press X to set up", tone: "hint" };
    if (!c.mods) return { text: "Reading...", tone: "hint" };
    if (c.anticheat.detected && c.anticheat.override_on) return { text: "Anti-cheat lock off", tone: "error" };
    if (c.loadOrder) {
      const w = warningSummary(c.loadOrder);
      return w.tone === "ok" ? { text: "Load order OK", tone: "ok" } : { text: `Load order: ${w.text}`, tone: w.tone };
    }
    if (list.length === 0) return { text: "No mods yet", tone: "hint" };
    if (active === 0) return { text: `All ${list.length} off`, tone: "hint" };
    return { text: updates ? "Updates waiting" : "Up to date", tone: updates ? "warn" : "ok" };
  })();
  return { active, updates, status };
}

/** "3 active", "1 active", "No mods". */
export function activeLabel(n: number, total: number): string {
  if (total === 0) return "No mods";
  return `${n} active`;
}

/** "1 update", "2 updates". */
export function updatesChip(n: number): string | null {
  return n > 0 ? `${n} update${n === 1 ? "" : "s"}` : null;
}

/** Where the game page puts Forge, in fallback order:
 * - "tab": a Mods tab in Steam's own tab container, plus the card under Play;
 * - "section": no tab container, so a Mods section that behaves like a tab
 *   (a focusable "Mods" tab header, the card, and the tab's content opening
 *   below it) under Play;
 * - "row": neither anchor - the old one-line row above the overview panel.
 * "none" when the page is not one Forge draws on. */
export type GamePagePlacement = "tab" | "section" | "row" | "none";

export function gamePagePlacement(o: { overviewFound: boolean; tabContainer: boolean; playSection: boolean }): GamePagePlacement {
  if (!o.overviewFound) return "none";
  if (o.playSection && o.tabContainer) return "tab";
  if (o.playSection) return "section";
  if (o.tabContainer) return "tab";
  return "row";
}

/** The id and title Forge's tab carries in Steam's tab container and in The
 * Collector's game page. */
export const MODS_TAB_ID = "forge-mods";
export const MODS_TAB_TITLE = "Mods";
