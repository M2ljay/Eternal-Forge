import type { CSSProperties } from "react";

import { alpha, BLACK, CRIMSON, CRIMSON_PRESSED, GUNMETAL, GUNMETAL_RAISED, STEEL, WHITE } from "./palette";

// Every colour lives in palette.ts (the Core palette: black, gunmetal,
// steel, one crimson accent, muted green/amber status). This file holds
// the shared button CSS and layout tokens built from it. The QAM panel
// stays native Steam styling apart from its status notes.
//
// Forge's surfaces (the game page Mods section, tile dots) read the same
// values through forgeRules.ts, which keeps its own copies so its node
// tests compile without the rest of the theme (tests/forge.test.mjs
// checks the copies still match palette.ts).
export { FORGE_BLACK, FORGE_CRIMSON, FORGE_GUNMETAL, FORGE_STEEL } from "./forgeRules";

// Injected once per page that uses the primary button. Hover covers desktop
// pointers; gpfocus is Steam's gamepad-focus class - the Gaming Mode "hover".
export const PRIMARY_BUTTON_CLASS = "nexus-mods-primary-btn";
/** Applied while an install is running: an indeterminate sweep, so a stage
 * that reports no progress still looks like work rather than a freeze. */
export const BUSY_BUTTON_CLASS = "nexus-mods-busy-btn";
/** Endorse pill - needs its own focus ring so a column of them can be navigated. */
export const ENDORSE_PILL_CLASS = "nexus-endorse-pill";
/** Health-check finding chip - opens the mod's page, or an off-Nexus link. */
export const LINK_CHIP_CLASS = "nexus-link-chip";
// Secondary action buttons need explicit focus states too: inline styles
// override Steam's focus background, leaving text unreadable on focus.
const WHITE_BUTTON_CLASS_NAME = "nexus-mods-white-btn";
const BLUE_BUTTON_CLASS_NAME = "nexus-mods-blue-btn";
export const WHITE_BUTTON_CLASS = WHITE_BUTTON_CLASS_NAME;
export const BLUE_BUTTON_CLASS = BLUE_BUTTON_CLASS_NAME;
export const PRIMARY_BUTTON_CSS = `
.${PRIMARY_BUTTON_CLASS} {
  background: ${CRIMSON} !important;
  color: ${WHITE} !important;
  font-weight: 600;
}
/* Focus keeps the crimson fill (white on it is 4.9:1; a lighter crimson
   would drop under 4.5:1) and adds a white ring as the indicator. */
.${PRIMARY_BUTTON_CLASS}:hover,
.${PRIMARY_BUTTON_CLASS}.gpfocus,
.${PRIMARY_BUTTON_CLASS}.gpfocuswithin {
  background: ${CRIMSON} !important;
  color: ${WHITE} !important;
  box-shadow: inset 0 0 0 2px ${WHITE};
}
.${PRIMARY_BUTTON_CLASS}:active {
  background: ${CRIMSON_PRESSED} !important;
}
/* A working install has to LOOK like one even when it has nothing to report.
   Compiling a Frostbite game spends about half a minute indexing the game's
   assets without printing a thing, and a parked bar in that gap reads as a
   crash - it did, on device. The stripe moves regardless of the percentage,
   so "slow" and "dead" stop looking the same. */
.${BUSY_BUTTON_CLASS} {
  position: relative;
  overflow: hidden;
}
.${BUSY_BUTTON_CLASS}::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    ${alpha(WHITE, 0)} 20%,
    ${alpha(WHITE, 0.22)} 50%,
    ${alpha(WHITE, 0)} 80%
  );
  transform: translateX(-100%);
  animation: nexus-busy-sweep 1.6s ease-in-out infinite;
  pointer-events: none;
}
@keyframes nexus-busy-sweep {
  to {
    transform: translateX(100%);
  }
}
/* The emphasised secondary button: steel with black text (12:1). Focus
   flips to white with a crimson ring - no glow. */
.${WHITE_BUTTON_CLASS_NAME} {
  background: ${STEEL} !important;
  color: ${BLACK} !important;
  transition: background 0.12s ease, transform 0.12s ease,
    box-shadow 0.12s ease;
}
.${WHITE_BUTTON_CLASS_NAME}:hover,
.${WHITE_BUTTON_CLASS_NAME}.gpfocus,
.${WHITE_BUTTON_CLASS_NAME}.gpfocuswithin {
  background: ${WHITE} !important;
  color: ${BLACK} !important;
  font-weight: 600;
  transform: scale(1.02);
  box-shadow: inset 0 0 0 3px ${CRIMSON};
}
/* The plain secondary button (was blue): gunmetal with steel text; focus
   is a lighter surface with a crimson edge, Core's menu style. */
.${BLUE_BUTTON_CLASS_NAME} {
  background: ${GUNMETAL} !important;
  color: ${STEEL} !important;
}
.${BLUE_BUTTON_CLASS_NAME}:hover,
.${BLUE_BUTTON_CLASS_NAME}.gpfocus,
.${BLUE_BUTTON_CLASS_NAME}.gpfocuswithin {
  background: ${GUNMETAL_RAISED} !important;
  color: ${WHITE} !important;
  font-weight: 600;
  box-shadow: inset 3px 0 0 ${CRIMSON};
}

/* The endorse pill has to show focus, or a column of them is unnavigable.
   Cyberpunk installs five frameworks: once each got its own row they were
   individually selectable and completely invisible, so you pressed down
   five times through nothing before the cursor reappeared below. Steam
   adds gpfocus/gpfocuswithin to whatever the gamepad is on. */
.${ENDORSE_PILL_CLASS}.gpfocus,
.${ENDORSE_PILL_CLASS}.gpfocuswithin,
.${ENDORSE_PILL_CLASS}:hover {
  background: ${GUNMETAL_RAISED} !important;
  border-color: ${CRIMSON} !important;
  box-shadow: 0 0 0 2px ${CRIMSON};
  transform: scale(1.04);
}
.${ENDORSE_PILL_CLASS} {
  transition: background 0.12s ease, box-shadow 0.12s ease,
    transform 0.12s ease;
}
/* Health-check findings are chips you can open: a missing mod goes to its
   page inside the plugin, an off-Nexus file to the browser. Michael asked
   for it after reading a finding he could do nothing with - "a user might
   want to read instructions on a mod". Same focus convention as the endorse
   pill, for the same reason: several per card, in a column. */
.${LINK_CHIP_CLASS}.gpfocus,
.${LINK_CHIP_CLASS}.gpfocuswithin,
.${LINK_CHIP_CLASS}:hover {
  background: ${GUNMETAL_RAISED} !important;
  border-color: ${CRIMSON} !important;
  box-shadow: 0 0 0 2px ${CRIMSON};
  transform: scale(1.04);
}
.${LINK_CHIP_CLASS} {
  transition: background 0.12s ease, box-shadow 0.12s ease,
    transform 0.12s ease;
}
`;

// ---- Action rows -----------------------------------------------------------
// The row of buttons under a mod's or collection's header.
//
// Every button in a row is the SAME width - no exceptions, not even the
// primary one. They shrink together as more actions appear and grow
// together (to a cap) as fewer do, so the row always reads as one set of
// controls rather than a ransom note. Four buttons of four different
// widths is what this replaced.
//
// The mechanism: identical flex-basis with flexGrow/flexShrink of 1 makes
// flex distribute space equally, so widths stay locked to each other; the
// max-width stops a two-button row becoming two slabs.

export const ACTION_BUTTON_MAX = 240;
export const ACTION_GAP = 10;

export const ACTION_ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: `${ACTION_GAP}px`,
  alignItems: "stretch",
};

export const ACTION_BUTTON: CSSProperties = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: "0",
  minWidth: "120px",
  maxWidth: `${ACTION_BUTTON_MAX}px`,
  // A label that wraps to two lines makes its button taller than its
  // neighbours - the row stops reading as one set of controls. Labels
  // are kept short enough to fit; this is the backstop.
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/** The page's ONE main action, alone on the row above the secondaries.
 * Width comes from the column (see ACTION_COLUMN) so it lands exactly on
 * the outer edges of the buttons beneath it - a deliberate relationship,
 * not a size picked by eye. */
export const ACTION_HERO: CSSProperties = {
  width: "100%",
  height: "44px",
  fontSize: "15px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/** Wraps the hero row and the secondary row. Both are 100% of it, so the
 * hero always spans exactly the secondaries - two buttons below means a
 * hero two buttons wide, three means three. */
export const ACTION_COLUMN: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: `${ACTION_GAP}px`,
};

/** Width of an action block holding `count` secondary buttons: the
 * buttons at their natural maximum plus the gaps between them. The hero
 * inherits it, which is what makes the two rows share an edge. */
export function actionColumnWidth(count: number): string {
  const n = Math.max(1, count);
  return `${n * ACTION_BUTTON_MAX + (n - 1) * ACTION_GAP}px`;
}

// ---------------------------------------------------------------------------
// Full-screen page scrolling
// ---------------------------------------------------------------------------
//
// SteamOS paints a button legend bar (STEAM / MENU / A Select / B Back)
// across the bottom of the screen, ON TOP of the page. Measured on a Legion
// Go 2 in Gaming Mode it is 42px tall in page pixels and sits flush with
// the bottom edge. A page that fills the screen therefore has to keep its
// last row above it or the row is unusable.
//
// This was "fixed" three times before by raising the bottom padding, and it
// never once moved the last row, because of the trap below.
//
// THE TRAP: Steam's stylesheet leaves these panels on `box-sizing:
// content-box`. With `height: 100%` and `padding-bottom: 110px`, the border
// box becomes 100% PLUS 110px - the scroll viewport grows below the screen
// by exactly the amount of padding, and the padding lands in the part that
// is off-screen. Clearance gained: zero, at any number you pick. Issue #29,
// diagnosed by measuring on device: the scroller's computed height was
// 804.5px, its clientHeight 915px, and the last row's bottom landed at
// y=845 on an 844px screen.
//
// `boxSizing: "border-box"` is what makes the padding real. It is not an
// optional tidy-up here, so the padding and the sizing live together in one
// object that every full-screen page spreads, and a test checks that no
// page writes its own.

/** Height of the SteamOS footer legend bar, plus breathing room. */
export const FOOTER_CLEARANCE = 72;

/** The scroll container of a full-screen page. Spread it, then add
 * whatever that page needs on top (a `scrollPaddingTop` for a pinned
 * header, `position: relative` for a backdrop). Do not re-state the
 * padding or the sizing: that is the whole point of it being here. */
export const PAGE_SCROLLER: CSSProperties = {
  height: "100%",
  // The Core palette's AMOLED ground; every surface on the page is
  // gunmetal on top of it.
  background: BLACK,
  // Without this the padding below is decoration. See THE TRAP above.
  boxSizing: "border-box",
  overflowY: "auto",
  // Clears the footer bar, and scroll-padding makes Steam's focus-driven
  // scrolling stop short of it too, so the last row is reachable AND
  // readable rather than merely scrolled to.
  padding: `0 24px ${FOOTER_CLEARANCE}px`,
  scrollPaddingBottom: `${FOOTER_CLEARANCE}px`,
};
