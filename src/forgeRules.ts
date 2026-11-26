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
  if (o.locked && (o.managed || o.experimental)) return "locked";
  if (o.managed) return "mods";
  return o.experimental ? "setup" : "hidden";
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
