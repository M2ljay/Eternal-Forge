// The Core palette: every colour the plugin's own UI paints with.
//
// Approved 2026-11-26 for all of the user's plugins so they sit together
// under Core (the couch-gaming app): AMOLED black behind, gunmetal
// surfaces, steel for secondary text, ONE accent (crimson) for both
// "selected/active" and "problem", and three muted status colours.
// Gold and yellow are gone on purpose; amber leans orange so it never
// reads as gold. See docs/design-language.md.
//
// Self-contained (no imports) so node tests can compile it alone.
// Mod thumbnails and Nexus artwork are never tinted with these.

// ---- Base -------------------------------------------------------------------
export const BLACK = "#000000";
/** Surfaces: rows, cards, unselected buttons. */
export const GUNMETAL = "#1A1D21";
/** Nested surfaces and borders, one step up from GUNMETAL. */
export const GUNMETAL_RAISED = "#2A2F36";
/** Secondary text, icons, inactive labels, outlines; also "neutral" status. */
export const STEEL = "#C9D1D9";
/** Hint text, captions. */
export const STEEL_MUTED = "#9AA4AE";
export const WHITE = "#FFFFFF";
/** Primary body text. */
export const TEXT = "#E6EAEE";

// ---- Accent -----------------------------------------------------------------
/** The one accent: selected/focused, active toggles and progress, AND
 * errors, conflicts and the anti-cheat lock. White on it is 4.9:1. */
export const CRIMSON = "#D7263D";
/** Crimson pressed / held. */
export const CRIMSON_PRESSED = "#B01E31";
/** Crimson as TEXT. Plain CRIMSON is 4.2:1 on black and 3.4:1 on
 * gunmetal, under the 4.5:1 the palette requires, so error and warning
 * words use this lighter step (5.0:1 on gunmetal). Fills, bars and
 * indicators keep CRIMSON. */
export const CRIMSON_TEXT = "#EA5A68";

// ---- Status -----------------------------------------------------------------
/** Installed / enabled / up to date / connected. 5.8:1 on gunmetal. */
export const GREEN = "#6FA37F";
/** Update available / pending / partial. 5.8:1 on gunmetal. */
export const AMBER = "#C98B4A";
/** Neutral / unknown / idle. */
export const NEUTRAL = STEEL;

// ---- Helpers ----------------------------------------------------------------
/** `alpha(CRIMSON, 0.14)` -> "rgba(215, 38, 61, 0.14)". For tinted
 * backgrounds and borders; text should use the solid tokens above. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** "r, g, b" for places that build `rgb(${tone})` / `rgba(${tone}, a)`. */
export function rgbTriplet(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** A control filled left-to-right with crimson to show progress. */
export function progressFill(pct: number, track: string = GUNMETAL_RAISED, strength = 0.55): string {
  return `linear-gradient(90deg, ${alpha(CRIMSON, strength)} ${pct}%, ${track} ${pct}%)`;
}
