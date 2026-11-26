# Design language

Rules for the plugin's own full-screen pages (Store, Mod detail,
Collection detail, Downloads, My Mods, Updates). The QAM panel
deliberately stays native Steam styling; only its status notes and
progress fills take the palette below.

Written down because "looks about right" kept producing rows of buttons
at four different widths. Every size here should be derivable from a
rule, not chosen by eye.

## Symmetry and asymmetry are both deliberate

The governing rule: **if two elements are not the same size, the
difference must come from a rule the eye can infer.** A button that is
merely *bigger* reads as a mistake; a button that spans exactly the two
beneath it reads as a decision.

Concretely, on the detail pages:

- Every button in a row is the **same width**. They share the row's
  space equally (`flexBasis: 0; flexGrow: 1`), so they shrink and grow
  together as actions appear and disappear. No button gets a wider slot
  for being more important.
- The page's **one main action** (Install this mod / Install the
  collection) sits alone on the row above, and is **exactly as wide as
  the whole row beneath it**. Its prominence comes from spanning them
  and from being taller (44px vs default), not from an arbitrary width.
- This is what `ACTION_COLUMN` + `actionColumnWidth(count)` in
  `theme.ts` implement: the column is `count × 240 + gaps` wide, the
  hero is `100%` of it, and the secondaries divide it. Two buttons below
  means a hero two buttons wide; three means three.

So: buttons within a row are symmetric; the hero is asymmetric to them
by an exact multiple. Both are legible as intent.

## Sizes

| Token | Value | Notes |
|---|---|---|
| `ACTION_BUTTON_MAX` | 240px | one action's natural width |
| `ACTION_GAP` | 10px | between buttons, and between the two rows |
| hero height | 44px | the only height that differs, and only for the one main action |
| tile width (store rails) | 195px | 5 tiles + the View-all card fit 1280 without scrolling |

Rails are sized so their **exit is visible**: a "View all" card the user
has to scroll to find may as well not exist. If a rail's length changes,
re-check that `n × TILE_WIDTH + gaps` still fits the screen.

## Labels

Buttons never wrap. A two-line label makes its button taller than its
neighbours and breaks the row's rhythm, which is worse than the words
being shorter. `ACTION_BUTTON` carries `nowrap` + ellipsis as a
backstop, but the real fix is the label: prefer `+ optional (12)` over
`Install All (inc 12 optional)`.

## Page furniture

Shared in `chrome.tsx` so the three full-screen pages read as one app:

- **`PageBackdrop`** — the page's own artwork, faded and (for arbitrary
  mod art) blurred, behind the header. It scrolls away with the content
  so it never competes once the user is reading.
- **`SectionHeading`** — the crimson accent bar plus a title. This
  is the 10-foot-UI signpost; use it for every section, not `<h3>`.
- **`StatChip`** — header facts (endorsements, downloads, version, mod
  count, size) as pills rather than a dot-separated sentence, so they
  can be scanned rather than read.
- **`StackedThumb`** — a collection thumbnail with card layers fanned
  behind it. A collection is a *deck of mods*, and it should look like
  one at a glance. Use `fit="contain"` wherever the artwork is meant to
  be looked at (page headers); `cover` is only acceptable on small tiles
  where cropping is expected.

## Colour

Forge uses the **Core palette**, the one shared by every plugin that sits
under Core, so it reads as part of the same set. Every value lives in
`src/palette.ts`; nothing else in `src/` writes a colour literal
(`tests/forge.test.mjs` fails on one). `forgeRules.ts` keeps copies of
four tokens because it compiles alone for its node tests, and the same
test checks they still match.

| Token | Value | Use |
|---|---|---|
| `BLACK` | `#000000` | the page ground (`PAGE_SCROLLER`), AMOLED. Never a grey panel background |
| `GUNMETAL` | `#1A1D21` | surfaces: rows, cards, chips, unselected buttons |
| `GUNMETAL_RAISED` | `#2A2F36` | nested surfaces, borders, the focused surface |
| `STEEL` | `#C9D1D9` | secondary text, icons, outlines, links; also "neutral / info" |
| `STEEL_MUTED` | `#9AA4AE` | hint text |
| `WHITE` / `TEXT` | `#FFFFFF` / `#E6EAEE` | primary text |
| `CRIMSON` | `#D7263D` | the one accent: selected, active, progress, the primary action, AND errors, conflicts, the anti-cheat lock |
| `CRIMSON_TEXT` | `#EA5A68` | crimson as words (see Contrast) |
| `GREEN` | `#6FA37F` | installed, enabled, up to date, endorsed, saved |
| `AMBER` | `#C98B4A` | update available, pending, needs installing, partial, "worth knowing" |

Small translucent white lifts (`alpha(WHITE, 0.05)` and similar) are
allowed for hairlines and row lifts over black; they add no hue. Mod
thumbnails and Nexus artwork are never tinted.

**What each colour means:**

- **Crimson** is the only accent. If something is crimson it is either
  selected, the main action, happening right now, or a problem. The
  primary button is a crimson fill; progress is a crimson fill; the tab,
  chip or toggle that is on is crimson with white text. Errors, script
  and file conflicts, mods left out because they break the game, and the
  anti-cheat lock are crimson too. `WarningBox` takes `tone="error"` for
  failures and refusals.
- **Amber** is "needs something from you, or later": an update is
  waiting, a required mod still needs installing, a mod was switched off,
  a setup note from the author, the default `WarningBox`. It leans orange
  so it never reads as gold.
- **Green** is "done and fine".
- **Steel** is neutral: info notes, external links, labels, a source's
  name (GameBanana's own yellow is not used: third-party brand colours
  are not UI accents).
- **Gold and yellow are gone.** No `#ffc83c`, no Nexus orange, no blue.

**Focus:** a gunmetal-raised surface plus a crimson indicator (a ring,
a 3px left bar, or a 3px underline), matching Core's QAM and Steam menu
style. The primary button keeps its crimson fill on focus and gains a
white ring. No glow, no haze, no gradient backgrounds; a dark scrim over
artwork (the page backdrop, the collection card) is the only gradient,
and it is black.

**Contrast:** text on gunmetal is at least 4.5:1. Plain `CRIMSON` is
only 4.2:1 on black and 3.4:1 on gunmetal, so crimson words use
`CRIMSON_TEXT` (5.0:1 on gunmetal); fills, bars, dots and borders keep
`CRIMSON`. White on a crimson fill is 4.9:1. Green and amber are 5.8:1
on gunmetal as text, but white text on them is not readable, so a green
or amber badge carries black text.

Progress is shown by **filling the control itself** left-to-right
(collection rows, the install hero, the QAM prefix-tool button) rather
than by a separate bar. One language for "this is working" everywhere.

### Forge surfaces

The Mods section on Steam's game page and the tile dots sit on Steam's own
pages and use the same palette: black behind, crimson for accents and
problems (an update, a lock, the restore offer), steel for secondary text,
gunmetal for surfaces. The crimson update dots on library tiles are an
approved design and stay crimson even though "update available" is amber
elsewhere. Focus is a crimson edge on a lighter surface. See
[forge.md](forge.md).

## Gamepad first

- Anything interactive is a `Focusable` or `DialogButton`; focus order
  follows visual order.
- Focus lands on the page's main action on mount, not on the first
  focusable in the DOM.
- Never move focus while the on-screen keyboard is up - it dismisses it.
