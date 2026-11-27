# Forge on the game page

Forge's goal is modding for every game in the library: Steam games,
non-Steam shortcuts and The Collector's ROMs (see "Every game in the
library" for the coverage table). Five features that live on Steam's own library pages rather than in the
Quick Access Menu, plus save backups through Ludusavi before mod changes,
per-game OptiScaler, and a LOOT-style load order with deploy profiles for
the Bethesda games. Built on Windows (Decky Loader in Steam Big Picture,
started by Core), and nothing in them is Windows-only except the crash
report check, OptiScaler's GPU lookup and the "game is running" check.

| Piece | Frontend | Backend |
|---|---|---|
| Mods tab and Overview card on the game page | `src/gamePagePatch.tsx`, `src/gamePageAnchor.ts`, `src/GameModsSection.tsx` | `forge_game_status` |
| ROM pages (The Collector) | `src/collectorBridge.ts`, `src/RomMods.tsx` | `py_modules/rom_mods.py`, `forge_rom_*` in `main.py` |
| Every other library game (shortcuts, no folder, no Nexus page) | `setUpGame` in `src/ExperimentalSetup.tsx`, `src/FolderPicker.tsx` | `set_game_folder`, `forge_list_folders`, `search_nexus_games`, `_experimental_install` |
| Anti-cheat lock | the section's locked state | `py_modules/forge_guard.py`, wrappers at the end of `main.py` |
| Way back after a crash | `src/forge.ts` (game start/exit), the section's offer | `forge_guard_*` |
| Update dots on tiles | `src/forge.ts` (one stylesheet) | `forge_update_dots`, cache filled by `check_updates` too |
| Steam collection "Modded" | `src/moddedSync.ts`, rules in `src/moddedCollection.ts` | `forge_note_modded`, `forge_modded_state`, `forge_set_modded_collection`, the `forge_mods_changed` event |
| Save backups (Ludusavi, optional) | `src/SaveBackup.tsx`, the section's save line | `py_modules/save_backup.py`, `forge_save_*`, `_wrap_save_backups` in `main.py`, the `forge_save_backup` event |
| Upscaling (OptiScaler) | `UpscalingEntry` in `src/GameModsSection.tsx`, run watch in `src/optiscaler.ts` | `py_modules/optiscaler.py`, `forge_optiscaler_*` and `_wrap_optiscaler_refusal` in `main.py` |
| Load order (LOOT rules) and profiles | `LoadOrderEntry` in `src/GameModsSection.tsx`, `src/ForgeLoadOrder.tsx`, `src/LoadOrderPage.tsx` (its `forge` mode), `src/forgeLoScope.ts` | `py_modules/load_order.py`, `forge_lo_*` and `forge_profile_*` in `main.py` |

Pure rules are in `src/forgeRules.ts` (tested by `tests/forge.test.mjs`),
`src/moddedCollection.ts` (tested by `tests/moddedCollection.test.mjs`)
`py_modules/forge_guard.py` (tested by `tests/test_forge.py`) and
`py_modules/optiscaler.py` (tested by `tests/test_optiscaler.py`) and
`py_modules/load_order.py` (tested by `tests/test_load_order.py`). The
save backups are tested by `tests/test_save_backup.py` against a fake
`ludusavi` that answers like the real one's `--api` mode.

The frontend parts can be switched off in the plugin's Settings, under
**Game page**.

## Mods tab and Overview card (anygame.72)

The approved design ("Core: current vision", boards 6 and 7): on every game
page mods are a **Mods tab** beside the page's own tabs, plus a **Mods card**
in the Overview. The card replaces the row under Play (anygame.70/.71); the
row is kept only as the last fallback.

### Where it goes, in order (`gamePagePlacement` in `src/forgeRules.ts`)

1. **Tab**: in every render the patch follows below the overview panel (see
   below), it also looks for a **tab container**: an element handed an array
   of at least two tabs, each with an id and a title (`tabs` or `sections`;
   `id`/`key`; `title`/`label`), the shape of Steam's tabbed page and of
   `@decky/ui`'s `Tabs` (`findTabContainer` in `src/gamePageAnchor.ts`).
   Forge's tab (`forge-mods`, "Mods") goes last, in a **new** array (Steam's
   own list is never changed in place), its content wrapped in the same error
   boundary. When the container is controlled (`onShowTab`), the card's X
   switches to it (`SteamTabs`). The card still goes under Play.
2. **Section** (no tab container): under Play, a focusable **"Mods" tab
   header** (crimson underline while open), the card, and the tab's content
   opening right below the card. A or X on either opens and closes it.
3. **Row** (neither the tab container nor the play section was found): the
   old one-line row above the overview panel, unchanged, behind the same
   failure budget and error boundary.

On a ROM page (The Collector's own page) Forge registers its tab with
`order: 25`, so Mods sits between Achievements (20) and Saves (30) as on the
board; The Collector's built-in orders are Overview 0, Achievements 20,
Saves 30, Media 34, Details 37, BIOS 40 (anygame.75).

The console says once which way: *Mods tab in Steam's tab container (level
N below the overview panel)*, *under Play (...)*, or the fallback line.

**Not seen on a TV yet**: whether Steam's game page renders a tab container
of that shape within four levels of the overview panel. If it does not, the
section form is what shows; nothing breaks either way.

### The card

Gunmetal, 10 px radius, one press down from Play:

- **Mods**, the active-mod count (*3 active*, *No mods*), and an amber chip
  with black text when updates exist (*2 updates*);
- **one status line**, most urgent first (`cardSummary`): *Locked ·
  Ricochet* (crimson), *Closed early twice · restore offered* (amber), *Not
  set up · press X to set up*, *Load order OK* / *Load order: 1 problem* (the
  Bethesda games), *No mods yet*, *All 4 off*, *Updates waiting*, *Up to
  date*;
- a controller prompt, **X Mods**; X (or A) opens the Mods tab. Focus is a
  square crimson edge around the card on a raised surface, no glow.

The tab's content is the old expanded view (lock, crash offer, Undo, mods
with switches, saves, Upscaling, Load order, Set up).

### Every game is offered setup

`sectionMode` no longer hides unmanaged games: any game without rules shows
the card with *Not set up*, and **Set up...** runs `setUpGame` right there
(it switches the any-game mode on itself). A locked game the plugin does not
manage now says *Locked* instead of showing nothing.

## ROM games (The Collector)

The Collector (eternal-romm, 0.33.0-win.28 and later) draws ROM pages itself
and offers two versioned globals (contract: The Collector's
`docs/architecture/game-mods.md#forge-bridge`):

- `window.__eternalGamePage` (`version: 1`): `register(ext)` returns an
  unregister function; ids are unique across kinds and registering an id
  again replaces it; `eternal_game_page_ready` fires on `window` each time
  the registry is installed (a reloaded Collector starts empty).
- `window.__eternalCollectorMods` (`version: 1`): `getTargets`,
  `listSources(appId, targetId?)`, `preview`, `install`, `listInstalled`,
  `remove`, `readSetting`, `enableSetting`, `openFolder`. No wrapper throws;
  failures are `{success: false, reason, message}`.

### Registration (`watchGamePage` in `src/collectorBridge.ts`)

- When the registry is there, Forge registers **`forge.mods`** as a `tab`
  (The Collector then hides its own Mods button) and **`forge.mods.card`** as
  an `overviewCard`. Plugins load in any order, so the global is looked for
  every 2 s, and the ready event registers again at once; a new global object
  (The Collector reloaded) gets a fresh registration.
- Unload unregisters both and stops looking.
- Without the registry (an old Collector, or another version), nothing is
  registered and the Steam route patch keeps skipping The Collector's pages
  (`collectorOwnsPanel`), as before.
- Rendering uses Steam's shared React (`window.SP_REACT`: `@decky/rollup`
  maps `react` to it, so the bundle has no React of its own), `@decky/ui`
  `Focusable` / `DialogButton`, and Forge's own error boundary inside The
  Collector's.
- Per-ROM state is re-read when the page switches to another version (same
  app id, new `romId`); Forge's records carry the `rom_id` they were
  installed for.

### The ROM card and tab (`src/RomMods.tsx`)

The card: Forge's mod count, the amber updates chip, one status line
(`romCardSummary`: *Ready · Dolphin*, *Texture packs is off*, *No known mod
folder for this emulator*, *Install the game to add mods*, *Update The
Collector to mod ROMs with Forge*), X opens the tab through `ctx.openTab`
(else the tab's content in a modal).

The tab: the mod folders The Collector found, a **Turn on** for an emulator
setting that is off (The Collector backs the ini up and refuses while the
emulator runs), **GameBanana**, **Nexus Mods**, **My Downloads**, **Open
folder**, the mods Forge installed (source, folder, version, **Update**,
**Remove**), and the other files in the mod folders with **Remove** (The
Collector's own Mods button is hidden while Forge's tab is registered).

### Sources

- **GameBanana**: the ROM is linked to its GameBanana game by name and
  platform (`forge_rom_link`, rules in `py_modules/rom_mods.py`, platform
  table in [gamebanana.md](gamebanana.md#rom-games-from-the-collector)); a
  link is made by itself only for one clear match, otherwise the same manual
  "pick the game" Forge has for Steam games (ranked candidates, a search, a
  `gamebanana.com/games/<id>` link). Links are shared with the Steam-game
  ones (`settings.json` → `gamebanana.games`, keyed by app id).
- **Nexus Mods**: an exact name match on Nexus' game list links by itself;
  otherwise candidates and a search. Few emulated games have a page there.
  Kept in `runtime/forge-rom-mods.json` (`links`).
- **Your own files**: the top of Downloads as The Collector lists it for the
  folder picked first (a soft-patch folder lists only patches).

### Installing (`runRomInstall`)

1. The user picks the mod, the file, and the target (one fitting target is
   used as is: a bare soft patch only to a patch target, a folder only to the
   others, a `.zip` to either).
2. `listSources(appId, target)` gives the Downloads folder The Collector
   reads. Forge's backend (`forge_rom_stage`) accepts it only when it is
   `%USERPROFILE%\Downloads` (the contract; a relocated Downloads folder is
   not followed), downloads through the usual pipeline (cache, progress,
   GameBanana checksum), and saves the file there under **the archive's own
   name** (`pack (2).zip` when taken). A `.zip` or soft patch is copied as
   is; `.7z` / `.rar` are unpacked into a folder named after the archive,
   because The Collector reads only `.zip`. The answer is the entry **name**.
3. `preview(appId, name, target)`: The Collector's preview (files, size,
   destination, replacements and where they are backed up) is shown in full
   before anything is written. A refusal is shown with The Collector's own
   message and reason.
4. `install(appId, name, target, fingerprint)` only after **Install**. A
   `changed` answer previews again and asks again (twice at most).
5. Forge records the mod (`forge_rom_record`: source, mod and file ids,
   version, file date, target, and the entries it added - new names, plus
   the top-level names the preview wrote that The Collector lists).
6. Forge removes the copy it put in Downloads (`forge_rom_unstage`: only
   names it recorded creating; the archive stays in Forge's cache). The
   user's own Downloads files are never removed.

No path ever goes to The Collector: only the entry name and a target id
(tested: `tests/collectorBridge.test.mjs`).

### Updates and removal

`forge_rom_updates` checks GameBanana records with `gamebanana.update_for`
and Nexus records with `rom_mods.nexus_update_for` (a newer MAIN/UPDATE file,
not a sibling upload). **Update** installs the new file through the same
preview into the same target; the record is replaced and keeps the entries
the new file writes again. **Remove** asks first, naming what moves, then
calls The Collector's `remove` per entry (moved to `romm-mod-backups`, never
deleted) and forgets the record once all went. A record with no known
entries is not removed (Forge never removes a whole folder for it).

### Mod kinds: Mods, Cheats, Built-in patches (anygame.73, Collector win.29)

The Collector's targets carry a `kind` since win.29 (a win.28 target without
one counts as `files`). Forge's ROM tab groups them
(`groupTargets` / `builtinGroup` in `src/collectorBridge.ts`):

| Group | Target kinds | What Forge shows |
|---|---|---|
| **Mods** | `files` (texture packs, RetroArch soft patch), `layeredFs` (Azahar `load/mods/<TitleID>`), `graphicsMods` (Dolphin GraphicMods, Cemu graphic packs), `riivolution` (Dolphin, Wii) | GameBanana, Nexus Mods, My Downloads, Open folder, the curated link-outs, Forge's installs (Update / Remove), other files (Remove), and each folder's emulator setting (*Load Custom Textures is off* + **Turn on**) |
| **Cheats** | `cheatFile` (Azahar `cheats/<TitleID>.txt`, PCSX2 `cheats/<SERIAL>_<CRC>.pnach`, RetroArch `cheats/<core>/<stem>.cht`), plus the cheat entries of the `builtinToggle` lists | The cheat warning, **Find cheats** (Azahar, RetroArch), **Cheat file from Downloads**, the link-outs, the installed cheat file (Remove), every cheat entry with **On / Off**, and *Enable Cheats* with **Turn on** |
| **Built-in patches** | the patch entries of `builtinToggle` lists: PCSX2's whole `patches` list, and Gecko / AR / cheat-code entries whose name says widescreen, 16:9, aspect, 60 FPS, frame rate, deinterlace, resolution, bloom, blur or fog | Each with **On / Off**, its description and notes |

**Switches.** `listBuiltins` is read for every `builtinToggle` target
(`gecko_codes`, `action_replay_codes`, `patches`, `cheat_codes`); each entry
shows its name, description and notes. When `can_toggle` is false, or the
list is not `editable`, the switch is disabled and the reason is shown
(`toggleBlock`). **On / Off** calls `setBuiltin`; a `changed` answer is shown
and the list is read again; `emulator_running` and the rest come back in The
Collector's words (`runSetBuiltin`). When the list's setting (Enable Cheats)
is off, turning an entry on says so and offers **Turn on**.

**Cheat warning.** Turning a **cheat** on (an entry, a cheat file's Enable
Cheats) asks first: *"Cheats can break saves; your saves are backed up by
The Collector"* only when The Collector's `getRomInfo` answers
`saveBackup: true` (win.30: save sync on and a save file synced to RomM, so
a copy exists to restore). `saveSync` alone does not count. Otherwise, and
with a Collector before win.30, it says *"Cheats can break saves. Back up
this game's saves before turning cheats on"* (`savesBackedUp`). Patches and switching off do
not ask.

**Card.** *3 mods · 2 patches · 1 cheat*: Forge-installed mods (a cheat
file is not a mod), enabled built-in patches, enabled cheats
(`countsLine`). Enable Cheats is named on the card only when some cheat or
patch is on.

**Emulators with nothing to install** (RPCS3, Xenia Canary, shadPS4, xemu):
The Collector answers no targets and `omitted` reasons; the tab lists them
under *Not offered* and offers no installs, and the card shows the first
reason.

### Cheat sources (`py_modules/rom_cheats.py`, `forge_rom_cheat_*`)

| Emulator | Source | Matching | Notes |
|---|---|---|---|
| Azahar (3DS) | GitHub [JourneyOver/CTRPF-AR-CHEAT-CODES](https://github.com/JourneyOver/CTRPF-AR-CHEAT-CODES), `Cheats/<Game> (<REGION>)/<TitleID>.txt` | By the Title ID The Collector read from the game file (`game_id`), case-insensitive. A Title ID is per region, so the match is the right region; when several files share it the user picks | No Title ID (`.3dsx`) -> says so. The repository states no licence; Forge only fetches one file on the user's PC at their request and never redistributes it |
| RetroArch | libretro's [libretro-database](https://github.com/libretro/libretro-database) `cht/<System>/<No-Intro name>.cht` (CC BY-SA 4.0) | System from the RomM platform slug (`LIBRETRO_SYSTEMS`); then up to eight likely names (`libretro_guesses`): the ROM file's own stem first (The Collector names the cheat target `<stem>.cht` after the ROM file, and No-Intro dumps carry the database's exact names), then the clean title with USA, World, USA/Europe, Europe, Japan. The ones that exist are offered; the user picks | 267 MB in all, so never listed. Nothing found -> use RetroArch's Online Updater or a `.cht` in Downloads. PS2, GameCube, 3DS have no folder there |
| PCSX2 | GameHacking.org (anygame.74, **personal use pending the site's permission**, see below) | By the serial The Collector read from the disc (`SLUS-20946`, compared without punctuation), then the title; the user picks when several match | The site's own pnach export for that game; else the link-out and the user's own `.pnach`. The Collector renames it to `<SERIAL>_<CRC>.pnach` |
| Dolphin | built in | `gecko_codes` / `action_replay_codes` lists | No file to fetch |

Nothing goes through api.github.com: it allows 60 unauthenticated calls an
hour per IP, shared by every device behind it, and the repository's test
(`test_notes_do_not_come_from_a_rate_limited_api`) refuses any code that
uses it. CTRPF is read from the repository zip on `codeload.github.com`
(about 1 MB, cached a week in `runtime/cheat-sources/ctrpf.zip`, a stale
copy used when the download fails); libretro files come from
`raw.githubusercontent.com`. Only paths that pass `valid_path` (the
`Cheats/<dir>/<TitleID>.txt` or `cht/<known system>/<name>.cht` shape, no
traversal) are read, at most 2 MB, refused when they are a web page or
binary. The file is saved at the top of Downloads under its own name and
installed through the usual preview into the `cheats` target, which writes
it as the target's `file_name`. A cheat-file target holds one file, so a new cheat file's
record replaces the old one. PCSX2 and Azahar cheats in a new file start
off: switch them in the Cheats list.

### GameHacking.org (PS2 cheats) - personal use, pending permission

**Status.** Forge fetches PS2 `.pnach` cheats from
[GameHacking.org](https://gamehacking.org) for the user's private,
non-commercial use. The site publishes no API and no terms granting
automated access; the user is asking the site for permission himself and
will have this removed if they refuse. Until then it is built to be a
polite personal-use client, and to come out in one change.

**Turning it off.**
- For yourself: Settings > Game page > **GameHacking.org cheats** (on by
  default). Off, every GameHacking.org call is refused before any request
  and the tab shows only the link-out.
- For the build (if permission is refused): set
  `GAMEHACKING_ENABLED = False` in `py_modules/gamehacking.py`. The
  callables refuse, the setting disappears, the button is not shown, and no
  request is ever made; the link-out and the user's own `.pnach` stay.

**What it does, and only this** (`py_modules/gamehacking.py`, callables
`forge_gh_status`, `forge_gh_set_enabled`, `forge_gh_find`,
`forge_gh_stage`):
- Only when the user presses **Find cheats (GameHacking.org)** on one PS2
  game's Cheats section. Nothing in the background, no bulk, no prefetch.
- `robots.txt` first (cached a day; a 404 means everything is allowed), and
  obeyed (RFC 9309: the group naming `Forge`, else `*`; longest rule wins,
  Allow on a tie; `*` and `$`). A disallowed path is never requested: the
  tab says *GameHacking.org's robots.txt asks programs not to fetch ...*
  and offers the link-out.
- At most four requests per press (robots.txt counts), at least 1 second
  apart, with the User-Agent `Forge/<version> (personal use)`, its own HTTP
  session with no cookie jar, no redirects followed.
- Find: the PS2 list page `/system/ps2/all`, and when the serial is not on
  it, the one list page for the title's first letter. Export: the game's
  page `/game/<id>` (its export form: `sysID`, `gamID`, and the `format`
  option that names pnach), then that form's own export,
  `POST /inc/sub.exportCodes.php` with the page as Referer. These are the
  site's pages as a browser gets them, read from a public open-source client
  of the site; **not verified from the PC**. Anything shaped differently
  counts as "not available" and links out.
- The lookup and the `.pnach` are cached per game for a week
  (`runtime/gamehacking/`); a second press makes no request.
- HTTP 429 and 5xx back off (Retry-After honoured, at least 2 minutes, at
  most an hour); after three failures in a session Forge stops asking until
  the plugin reloads (Settings says so).
- No login, no CAPTCHA solving, no bypassing: a 403/503, a browser check
  (`captcha`, `cf-chl`, *Just a moment*) or a web page where a file was
  expected falls back to the link-out, and counts as a failure.
- The file must look like a pnach (text with a `patch=` line, at most
  2 MB). It is saved at the top of Downloads under its own name (the
  export's file name, else `<SERIAL>.pnach`) and installed through The
  Collector's preview into the `cheats` target, which renames it to
  `<SERIAL>_<CRC>.pnach`. The usual cheat warning applies when a cheat is
  switched on.
- The UI credits the site: *Cheats from GameHacking.org*.

Tests: `tests/test_gamehacking.py` against a fake site (robots rules and
fallback, the per-press budget, spacing, User-Agent, caching across
sessions and its expiry, serial and title matching, the export form, 429
back-off, the session stop, bot checks, HTML instead of a pnach, the user
switch and the kill switch).

### Link-outs

Places the guides name that have no API open in Steam's own browser
(`Navigation.NavigateToExternalWeb`), controller only, nothing fetched:
Dolphin forums *Custom Texture Projects* and Henriko Magnifico (Dolphin),
the *PCSX2 HD Textures Project* (PCSX2), Henriko Magnifico (Azahar),
GameHacking.org (PCSX2 cheats), and a GBAtemp search for the 60 FPS cheat
code thread (Azahar). No QR code: Forge bundles no QR encoder.

## Every game in the library

| Game kind | Mod sources | Where mods go | Status |
|---|---|---|---|
| Curated Steam game (the 25 supported) | Nexus Mods, GameBanana | The game's rules in `src/games.ts` | Works (as before) |
| Other Steam game, Nexus page found | Nexus Mods, GameBanana | Guessed mods folder (`experimental_games.inspect_install`); **Mods folder > Change** lists likely folders, a typed folder, or **Browse folders...** (controller picker inside the game folder) | Works; set up from the card or the QAM |
| Other Steam game, no Nexus page | GameBanana only (`noNexus`, local domain `local-<app id>`, never sent to Nexus; Browse opens GameBanana) | Same as above | Works |
| Non-Steam shortcut (other launcher, standalone exe) | Nexus Mods (matched by name, picked or searched by hand), or GameBanana only | Folder from the shortcut's start folder (`strShortcutStartDir`, else the exe's folder), else the controller folder picker; remembered per app id (`forge_game_folders`), changeable in the QAM (**Game folder > Change**) | Works; card and tab on its Steam page |
| Game Steam has no install record for | As above | Controller folder picker | Works |
| ROM mods (Dolphin, PPSSPP, PCSX2, Azahar/Citra, RetroArch soft patches, Cemu graphic packs) | GameBanana (name + platform), Nexus Mods where a page exists, own files in Downloads, link-outs (Dolphin forums, PCSX2 HD Textures Project, Henriko Magnifico) | The Collector's Mods targets: texture packs, LayeredFS, graphics mods, Riivolution, soft patches | Works with The Collector 0.33.0-win.28+ (kinds: win.29); older Collector: page left alone |
| ROM cheats: Azahar | CTRPF-AR-CHEAT-CODES by Title ID, own file | `cheats/<TitleID>.txt` (The Collector names it); entries switched in the Cheats list | Works (win.29) |
| ROM cheats: RetroArch | libretro cheat database by system + name, own file | `cheats/<core>/<stem>.cht` | Works (win.29) |
| ROM cheats: PCSX2 | GameHacking.org pnach export on the user's press (personal use pending permission; switchable), own `.pnach` from Downloads, link-out | `cheats/<SERIAL>_<CRC>.pnach`; Enable Cheats + entries in the Cheats list | Works (win.29); GameHacking.org fetch unverified from the PC |
| ROM cheats and built-in patches: Dolphin (Gecko / AR), PCSX2 (patches, cheat codes), Azahar (cheat codes) | Built into the emulator | Switched On/Off with The Collector (`setBuiltin`); Enable Cheats offered | Works (win.29); read-only entries show why |
| ROM on RPCS3, Xenia Canary, shadPS4, xemu (and emulators The Collector does not know) | - | none | The Collector's reasons shown under *Not offered*; no installs |
| VR games | Same as their kind above (the VR file guard applies to every install) | Same | Works |
| Anti-cheat game (client-side anti-cheat) | Refused: installs and switching on are blocked by the backend, the card says *Locked · <anti-cheat>* and **Why?** explains; the per-game override stays one press in **Why?** | - | Refused, reason shown (unchanged protections) |
| Soundtracks, tools, videos | - | - | Not shown (not games) |

**Needs the TV**: the folder hint read from `appDetailsStore` for a shortcut,
the picker's drive list, and a full shortcut setup.

## The Mods section

Steam's game page is `/library/app/:appid`. Like ProtonDB Badges and HLTB
for Deck, the plugin adds a `routerHook.addPatch` on that route and follows
`renderFunc` with `createReactTreePatcher` to the app details
`InnerContainer`, which holds the header (hero) and Steam's own overview
panel. The overview panel is recognised by the props it is rendered with
(`overview`, `details`, `bFastRender`), the same shape HLTB for Deck keys on.

### Where it goes: under the Play bar

The overview panel draws the Play bar, the stats and the tabs itself, so
anything spliced into `InnerContainer` lands either above Play (over the
hero) or below every tab. The section goes **directly under the Play bar**
instead, from inside the panel's own renders.

What is proven on the TV (stable Steam, Decky 3.3.1): The Collector
(eternal-romm) logs `replacing AppDetailsOverviewPanel at index 2 with RomM
wrapper (cls=_1_cYNJSvS6IXs9vLTEYjy5)`. So `InnerContainer`'s children hold
the overview panel's wrapper at index 2, with a class, and the panel element
under it carries `overview`, `details` and `bFastRender`: the same lookup
Forge uses (`overviewIndex`, `findInsertionChildren`). The Collector replaces
that panel wholesale, so its logs say nothing about the panel's inner render.
Its own notes say the panel draws Play and the tabs through an inner
component (`se` in Steam's bundle).

anygame.70 followed the panel's component one level and looked for the play
section in that one render; on the TV it was not there, and the one-line
fallback showed above Play. From anygame.71 the patch keeps following: in
each render below the panel that has no play section, every component that
is handed the game (an `overview` or `details` object prop; function, class,
memo or forwardRef components only) is followed one level further, up to
`PLAY_SEARCH_DEPTH` (4) levels and `MAX_CARRIERS` (8) components per render
(`gameCarriers`, `locatePlaySection` in `src/gamePageAnchor.ts`). Each level
has its own `createReactTreePatcher`, cached per component type. In the first
render that holds the play section, the section is spliced in right after
it; if that render's root element *is* the play section, the section is
returned beside it in a fragment, never inside it. The play section is found
by its class, `basicAppDetailsSectionStylerClasses.PlaySection`, else
`playSectionClasses.Container` (outer one first), both looked up through
`resolveClassModule` (whole class names only). The followed renders only
place the section for the game the route is drawing (`activeAppId`), so a
component Steam also uses elsewhere never grows a row there. Should Steam draw
the play section twice, only the first copy mounted is shown
(`PlacementRegistry.isFirstBelow`).

The old anchor stays as the fallback: a copy in `InnerContainer` right before
the overview panel, which renders **nothing** while a copy under Play is
mounted (`PlacementRegistry` in `src/gamePageAnchor.ts`). When no copy under
Play mounts within 600 ms (an unknown or stale class, a play section deeper
than four levels, a failure in that patch), it shows as a **single line**
that never expands: A on it opens the game's full Forge page instead.

The console (CEF DevTools) says once per session which path was used:

- *Forge game page: Mods row under Play (level N below the overview panel,
  after the play section)*, or *... beside the play section's render*;
- *Forge game page: Mods row above the Play bar (fallback): no play section
  within 4 levels of the overview panel*, followed by an outline of the
  panel's first render (component names, classes, prop names), so the next
  TV log shows what Steam drew instead;
- *Forge game page: Mods row left out (The Collector draws this page)*;
- *no play section class on this Steam build* when neither class resolves.

RomM shortcuts: The Collector replaces the overview panel with its own
wrapper (key `romm-play-section`, `data-romm="true"`). The route patch does
not draw there (`collectorOwnsPanel`), whichever plugin's route patch runs
first: since anygame.72 Forge is on that page through The Collector's own
game-page API instead (see "ROM games" above), and the log says *on The
Collector's page*. Other non-Steam shortcuts (app type `1 << 30`) get the
card and tab like Steam games (`isGameType`).

**Still to confirm on a TV**: that the play section is within four levels of
the panel and is handed the game along the way. The depth search is tested
on fake trees shaped like The Collector's evidence and against @decky/ui's
real tree patcher, not on Steam's own components.

`InnerContainer` is found by its class from `appDetailsClasses`, looked up
through `src/gamePageAnchor.ts`: the named `@decky/ui` export, else
`findClassModule`, else `findVar` (only in `@decky/ui` 5). The loader supplies
`@decky/ui`: 4.x under Decky 3.3.1, 5.x under Decky 4.0, whose Steam client
renamed nearly all classes and whose class names are pinned per Steam build.
When the class is missing or stale, the fallback goes into whichever
children array holds the overview panel. No overview panel, no section.

### What the fallback row shows

Since anygame.72 this row is only the last fallback (neither Steam's tab
container nor the play section found); its expanded details are the Mods
tab's content.

**Collapsed (the default)**: one row, 56 px tall, gunmetal with a thin
crimson bar on the left (`ROW_HEIGHT`, `statusChips`, `compactButtons` and
`savesHint` in `src/forgeRules.ts`):

- **Mods** and one or two status chips: *Locked · Ricochet* (crimson text),
  *Lock off* (crimson, the override is on), *Updates 2* (amber),
  *Restore offered* (amber), *3 enabled* (steel), *All 4 off*, *Not modded*,
  *Not set up* (hint);
- the last save backup as hint text (*Saves backed up 2 h ago*, *No save
  backup yet*, an amber *Save backup failed*), only with Ludusavi;
- at most two buttons, most relevant first: **Restore mods...** (the crash
  offer), **Undo restore**, then the way to the game's full page (**Mods...**:
  My Mods, or the store when nothing is installed; **Set up...** in the
  any-game mode; **Why?** for a locked game Forge does not manage), then
  **Restore saves...** when a backup exists.

**Expanded** (A on the row; A again folds it): one line per subject, each a
label, a single line of text cut with an ellipsis, and its buttons
(`detailLines`): the anti-cheat lock (**Switch N off**, **Why?**) or the
override (**Lock mods again**, **Why?**), the crash offer (**Restore...**,
**Not now**, **Why?**), **Undo restore**, the mods (count, **Add mods**,
**My Mods** or **All N...**, then up to six mods - updates first, then the
ones that are on - each a switch plus **Open** / **Update**), saves
(**Restore saves...**), Upscaling and Load order. Long explanations are
behind **Why?**, in a small modal. Text is 16 px (the title 18 px, buttons
15 px, hints and chips 14 px at 1080p), in line with Steam's game-page meta
text, and nothing on the page wraps.

Pages opened from here go back to the game page on B, not to the Quick
Access Menu (`pushFromGamePage` in `src/Tabs.tsx`).

For a game the plugin does not manage it shows nothing, unless the
experimental any-game mode is on, in which case it offers to set the game
up (from the Quick Access Menu).

### Failing safe

The page belongs to Steam, so every failure leaves it as Steam drew it:

- each step of the patch is in a `try`; a failure returns Steam's tree
  unchanged;
- the section renders inside an error boundary that renders nothing on an
  error;
- after three failures of either kind in a session the patch stops touching
  the page until the plugin reloads (`FailureBudget`);
- when the overview panel is not found (soundtracks, tools, a Steam update
  that moved things) nothing is inserted;
- the section never takes focus. Play keeps the page's first focus; the
  row is one press down from it (one press up in the one-line fallback),
  works with the D-pad and A alone, and leaves B to Steam;
- the route patch is removed when the plugin unloads.

## Anti-cheat lock

Games with an anti-cheat that runs on the player's PC are locked: the
section says so (*Locked · Ricochet*; the explanation is behind **Why?**),
offers to switch any installed mods **off**, and every
backend call that puts mod files into the game or switches mods **on** is
refused with `{"ok": false, "anticheat_locked": true, "error": ...}`. That
covers `install_mod`, collection installs, frameworks, prefix tools, mod
programs, ReShade, mod setups, `set_mod_enabled` (on), `set_all_mods_enabled`
(on), plugin and framework switches, and the rest listed in `_FORGE_GATED`.
Switching off and uninstalling are never refused. The refusal runs before
the restore point and before any file work.

It also covers the paths whose game is in saved state rather than in the
call: finishing a parked FOMOD (`install_fomod`, `install_fomod_auto`,
checked when it finishes, so a lock turned back on after the token was made
still applies), the crash hunt (`crash_bisect_start` / `_apply` / `_finish`,
from the hunt's state), Saints Row 2's GotR options (on), script-extender
DLLs coming back, `set_mod_option`, and the load-order writers that can
switch entries back on. `tests/test_forge.py` (`StructuralGateTests`)
enumerates every backend callable and fails unless it is gated or on an
allow-list of read-only, switch-off, remove and bookkeeping calls, each
group with its reason.

The gate fails closed. The game is resolved from the call's app id, then
the backend's own records (domains the frontend registered, the app ids
restore points recorded, experimental games, and the Steam library
manifests for an install folder). When none of them names the game, or the
lookup throws, the call is refused with `"reason": "game_unknown"` and a
message saying Forge could not tell which game it is. A folder walk that
throws for a known game falls back to the list, so a listed game stays
locked.

The QAM shows the same locked state and the same two buttons at the top of
the game's sections (`ForgeLockSection` in `src/ForgeLock.tsx`). The QAM's
other install buttons (Step 1 frameworks, collection and mod installs) are
not individually hidden; while the game is locked the backend refuses them
with the lock message.

Where the verdict comes from, in order:

1. **Per-game override.** Off by default, offered for **every** locked
   game, online-only ones included. On the game page it is only in the
   lock's **Why?** modal (`LockWhyModal`, `lockModalActions`), never on the
   row or the expanded lines; there, and in the QAM, it is **one press**:
   no further dialog. The risk is on the button and in the locked text:
   - games with an offline or anti-cheat-off mode (`OFFLINE_CAPABLE`: Elden
     Ring, Nightreign, Dark Souls III, Armored Core VI, GTA V, Halo MCC) read
     *"Allow mods anyway - play modded offline only"*;
   - everything else (online-only titles in `ONLINE_ONLY` such as Call of
     Duty, Counter-Strike 2, Rainbow Six Siege, Apex, Marvel Rivals, and any
     game found only by its anti-cheat files) reads *"Allow mods anyway -
     may get this account banned"*.
   While it is on, the section and the QAM say so and offer **Lock mods
   again**. The override is a flag in the backend's state file, and that
   flag is what the install gate reads, so the frontend cannot unlock a
   game any other way.
2. **The list.** `py_modules/anticheat_games.json`, 500 Steam app ids with
   a client-side anti-cheat, generated by `tools/make_anticheat_list.py`
   from [AreWeAntiCheatYet](https://github.com/AreWeAntiCheatYet/AreWeAntiCheatYet)'s
   `games.json` (MIT, (c) 2021 Starz0r, Curve; source hash and date are in
   the file). Kept: Easy Anti-Cheat, BattlEye, GameGuard, XIGNCODE3,
   Ricochet, Vanguard, FACEIT, EA Javelin, ACE, NetEase and similar. Left
   out on purpose: VAC and PunkBuster (Left 4 Dead 2 and Garry's Mod are
   mod-first games) and FairFight (server side only - Battlefront II has
   nothing else). `EXTRA_GAMES` adds a few the list lacks (GTA V Enhanced,
   Overwatch 2, Counter-Strike 2, Warframe).
3. **Files in the game folder.** The marker names Core's Gaming Mode agent
   uses for its anti-cheat safe mode
   (`Source/GamingModeAgent/GamingMode.Services/AntiCheatProtection.cs`,
   `AntiCheatCatalog.FolderMarkers`): `EasyAntiCheat`, `BattlEye`,
   `start_protected_game.exe`, `randgrid.sys`, `EAAntiCheat.*.exe`,
   `GameGuard`, `XIGNCODE` and the rest. The game folder and its direct
   subfolders are read by name only, and the result is cached ten minutes.

Steam's store pages carry a kernel anti-cheat disclosure since October
2024, but the client exposes no documented field for it to plugins, so it
is not used.

What this means for supported games: **Elden Ring** (EAC) and **Helldivers
2** (GameGuard) are locked until the override is turned on for them.
Elden Ring's modded launches already run offline through ME3, so it gets
the offline wording; Helldivers 2 is online-only and gets the ban wording.

To regenerate the list: download `games.json` from the repository above and
run `python tools/make_anticheat_list.py path/to/games.json`.

## Way back after a crash

At every game start the plugin records the set of mods that are on
(`forge_guard_launch`). At exit (`forge_guard_exit`) the run is:

- **clean**: it lasted at least 60 seconds and Windows wrote no crash report
  for the game. Its mod set becomes the *last known good* set;
- **failed**: it ended within 60 seconds, or Windows Error Reporting wrote
  an `AppCrash_<exe>` report for one of the game's executables while it ran
  (`%ProgramData%` and `%LOCALAPPDATA%` `\Microsoft\Windows\WER\ReportArchive`
  and `ReportQueue`, folder names and times only). Steam tells plugins only
  that a game started and stopped (`SteamClient.GameSessions.
  RegisterForAppLifetimeNotifications`, `{unAppID, bRunning}`), never an
  exit code.

A failure only counts when the mods that were on differ from the last known
good set (otherwise going back changes nothing). Two failures in a row
after a mod change make the offer: **one** notification ("Restore last
working mods?", which opens the game page), and **Restore mods...** on the
game page's Mods row (with a *Restore offered* chip) until it is answered.

Restoring switches mods installed since the good run **off** and mods that
were on then back **on**, through `install.ts` like every other switch.
Nothing is uninstalled or deleted; a mod removed since stays removed and is
named. With no clean run on record the way back is every mod off. The set
from before the restore is kept for a week, and **Undo restore** on the game
page puts it back. The record is cleared only when every change of the undo
went through; if any was refused (a locked game, a busy folder) it stays,
the toast names what was not restored, and Undo can be tried again (it then
switches only what still differs). A clean run, a new change to the mods, or **Not now**
ends the streak.

Starting the game twice within 15 seconds with the same mods (a launcher
handing over) counts as one start.

## Update dots

A small crimson dot on library and home tiles of games with mod updates.

Data: `forge_update_dots` computes updates from the install records and a
cache of Nexus versions (`runtime/forge-update-cache.json`) with the same
rules as the Updates page (collection pins respected, companion files follow
their parent, an ignored version stays ignored). With `refresh`, games
whose cache is older than **six hours** are fetched again, **three games per
call** at most, and calls that reach Nexus at least **20 seconds** apart; a
game with no tracked mods is never fetched. Every `check_updates` the plugin
already runs (Updates page, QAM) refreshes the same cache for free. The
frontend asks a minute after start and then every 30 minutes; an install or
a switch recounts from the cache without the network.

Drawing: one `<style>` element in Steam's main window (`findSP()`), CSS
only. A tile's capsule image carries its app id in its URL
(`/<appid>/library_600x900`, `/<appid>/library_capsule`, custom art
`<appid>p.<ext>`), and `:has()` puts the dot on the image's wrapper. A Steam
update that renames these makes the selector match nothing: the dots
disappear and no tile breaks. The element is removed on unload and when the
setting is off. The game page shows the same count as a chip whatever
happens to the tiles.

**Not verified on a TV yet**: whether the dot lands in the tile's top-right
corner depends on the wrapper being positioned in Steam's current markup.
If it lands somewhere odd, switch it off in Settings; the counts stay on
the game page.

## The Modded collection

A Steam collection called **Modded** holding every game that has at least
one mod on through Forge: a mod the plugin installed (tracked) that is
switched on, loose-file mods without a switch included. A folder the plugin
found but did not install does not count. A game goes in when that becomes
true and comes out when it stops being true, whichever way the mods went
off: a switch, Disable all, an uninstall, a reset, the crash guard's
restore, or the anti-cheat lock's "switch mods off".

### When it is updated

- **At load**, 20 seconds after the plugin starts (so Steam has loaded its
  collections first), every managed game is recounted. Games whose domain
  has no install records are counted as 0 without being read.
- **After every mod change.** Every backend call that can put a mod in,
  switch one, or take one out (the `_FORGE_GATED` list plus uninstalls,
  resets, FOMOD installs, parking and disabling failing mods/plugins) ends
  with a `forge_mods_changed` event naming the game's domain and app id.
  The wrapper is applied last, so a call the anti-cheat gate refused sends
  nothing. The frontend collects the games that changed and, once nothing
  has changed for **2 seconds**, recounts only those games; an event with no
  domain recounts every game. Runs never overlap. A collection install of
  hundreds of mods is one reconcile at the end, not hundreds.
- **When the switch is turned back on.**

Counting is `get_installed_mods` per game, the same read My Mods does, so
disk is the truth. It is all local: no Nexus call is made, and it works
offline. A count that cannot be read (the call failed) keeps what was known
for that game rather than taking it out.

The backend keeps the result in `runtime/forge.json`: `modded`
(`{app_id: {domain, on, at}}`, games with at least one mod on) and
`collection` (the record below). The Steam side is done from the frontend
with Steam's `collectionStore`, like The Collector does it:
`NewUnsavedCollection` + `AsDragDropCollection().AddApps` + `Save` to
create, `AddApps` / `RemoveApps` + `Save` to update, `Delete` to remove.
Nothing writes Steam's files.

### Ownership

Forge touches exactly one collection: the one whose Steam id it recorded
when it created it (`collection.id` in `forge.json`).

- **Found by id, never by name.** A collection called "Modded" is Forge's
  only if its id is the recorded one. A user's own "Modded" is never
  changed, filled or deleted.
- **Name clash.** When Forge has to create its collection and "Modded" is
  taken (Steam compares names case-insensitively), it creates **Modded
  (Forge)** instead (then "Modded (Forge 2)", and so on) and records the
  clash. Settings says so: *a collection called "Modded" already existed
  and is yours, so Forge left it alone.*
- **Only Forge's games come out.** The record lists the games Forge itself
  added (`collection.added`). A game is only ever removed if it is on that
  list. A game the user put in by hand stays, modded or not; a modded game
  that was already there by hand is not claimed.
- **Created only when needed**: nothing is created while no game is
  modded. Once made, the collection stays even when it is empty.
- **Renamed** by the user: still Forge's (same id), and Settings shows the
  new name.
- **Deleted** in Steam: Forge forgets the record and makes a new one the
  next time a game is modded (while the switch is on).
- **Taken out by hand** while still modded: it is put back at the next
  reconcile. To stop that, turn the switch off.

### Settings

Under **Game page**:

- **Keep a Modded collection** (on by default). Turning it off stops the
  updates and leaves the collection exactly as it is; nothing is deleted.
  The backend keeps counting, so turning it back on is right straight away.
- **Remove Modded collection** deletes Forge's own collection (found by its
  recorded id), and nothing else, then forgets it. It also turns the switch
  off, or the collection would come back with the next mod change. The row
  names Forge's collection and any name clash.

**Not verified on a TV yet**: that `collectionStore.userCollections` is
complete 20 seconds after load on every start (a user's "Modded" that has
not loaded yet would look like a free name), and that a collection's `id`
is set once `Save()` has returned (the code falls back to finding it by its
new name).

## Save backups before mod changes (Ludusavi)

Forge can back a game's saves up with
[Ludusavi](https://github.com/mtkennerly/ludusavi) (MIT) before it changes
that game's mods. Ludusavi is **optional** and is never installed by Forge:

```
winget install -e --id mtkennerly.ludusavi
```

### Finding it

`ludusavi` / `ludusavi.exe` on the loader's PATH first, then the places a
loader started before the install would not see on PATH: winget's
`%LOCALAPPDATA%\Microsoft\WinGet\Links` and
`Packages\mtkennerly.ludusavi_*` (the winget package is a portable zip,
command alias `ludusavi`), the same under `%ProgramFiles%\WinGet`, and
Scoop's `apps\ludusavi\current` and `shims` (under `%SCOOP%` or
`%USERPROFILE%\scoop`, and `%SCOOP_GLOBAL%` or `%ProgramData%\scoop`). The
answer is cached for five minutes; Settings looks again when it opens.

Without it, Settings shows one line (*Install Ludusavi to back up saves
before mod changes*), the game page says nothing about saves, and nothing
else changes.

### When a backup runs

- **Before every call that puts mods in or switches them on** for a game:
  the same list the anti-cheat lock guards (`_FORGE_GATED`, the "on"
  direction only), so installs, collections, frameworks, enabling a mod or
  all mods, load-order writers and the rest are covered wherever they are
  started from. Switching off and uninstalling never back up. The wrapper
  sits **inside** the anti-cheat lock: a call the lock refuses backs up
  nothing.
- **Before the crash guard's restore and before Undo**, from the game page
  (`forge_save_backup`).
- **Before a save restore**, always (see below).

A backup for a game is **skipped** when one for that game already ran (worked
or not) within the window: 30 minutes by default, 0 to 120 in Settings. A
collection of 300 mods is one backup, and a broken Ludusavi is not retried
before each of them. Concurrent calls for one game wait for the one backup
in progress.

**Time box: 60 seconds** for the title lookup and the backup together. When
it runs out Ludusavi is stopped (`subprocess.run(timeout=...)` kills it).
**A backup never blocks the mod change**: a timeout, a crash, files Ludusavi
could not read, an unknown game, or an error inside Forge's own code is
logged, sent as a `forge_save_backup` event (one small toast, *Save backup
failed ... The mod change went ahead.*), and the call goes on. Ludusavi runs
with `CREATE_NO_WINDOW`: it is a console program and would otherwise flash a
window over the game.

### Ludusavi's command line (checked against v0.31.0)

All in `--api` mode (JSON on stdout; stdout can be blank on some errors,
stderr carries human-readable warnings). `--try-manifest-update` keeps an
offline PC working, since Ludusavi otherwise fails when its manifest
download fails.

| Step | Command |
|---|---|
| Ludusavi's name for the game | `ludusavi --try-manifest-update find --api --steam-id <app id>`, then by the exact Steam name, then `--normalized` (a name matching more than one title is not used). Non-Steam shortcuts (app ids with the top bit set) skip the Steam id. Remembered in `forge.json` for a week, a miss for a day |
| Backup | `ludusavi --try-manifest-update backup --force --api <title>`. Worked when `games.<title>.decision` is `Processed`, no file has `failed`, and `errors.someGamesFailed` is unset. No save files found counts as worked (nothing to lose). A failed cloud sync still counts: the local copy is made |
| List | `ludusavi backups --api <title>` -> `games.<title>.backups[]` with `name` (the id), `when` (RFC 3339, UTC), `comment`, `locked`, `os` |
| Restore | `ludusavi --try-manifest-update restore --force --api --backup <id> <title>` |

Backups go to the folder **Ludusavi's own configuration** names; Forge
passes no `--path` and never edits the config. Cloud sync follows Ludusavi's
setting too. With `--force`, a cloud conflict is left alone rather than
resolved (Ludusavi's own behaviour). One trade-off: if a cloud upload is
still running when the 60-second box ends, Ludusavi is stopped mid-sync and
will report the cloud as out of step the next time it runs.

### Game page and Settings

With Ludusavi installed, the Mods row shows *Saves backed up 12 min ago* (or
*No save backup yet*) as hint text, an amber *Save backup failed* when the
latest attempt did not work, and **Restore saves...** once a backup exists;
the expanded view has a Saves line with **Restore saves...** whenever
Ludusavi knows the game. Both also show on anti-cheat locked games: a backup
only reads the game, and a restore puts saves back, not mod files.

**Restore saves...** lists Ludusavi's backups of the game, newest first, and
restores one only after a confirmation. The backend refuses without that
confirmation flag, then takes a **fresh backup of the current saves first**
(the switch and the skip window do not apply to this one); if that backup
fails, nothing is restored. The frontend also refuses while the game is
running.

Settings, under **Game page**: **Back up saves before mod changes** (on by
default; kept in `forge.json` because the backend acts on it) and the skip
window. The restore's own backup runs even with the switch off.

**Not verified on a TV or a real Ludusavi yet**: the command lines and the
JSON fields come from Ludusavi's documentation and source (v0.31.0), and the
tests run against a fake that answers the same way. Check on the PC that a
Steam game's title is found by its id, that a backup appears in Ludusavi's
folder, and that the restore list matches Ludusavi's own.

## Upscaling (OptiScaler)

A line in the game page's Mods section (expanded view), **Upscaling**, that
puts [OptiScaler](https://github.com/optiscaler/OptiScaler) into one game:
it takes the upscaler a game already offers (DLSS, FSR 2/3 or XeSS) and
runs another one in its place. Shown wherever the section is (managed games,
the any-game setup offer, locked games).

### Licence and source

- OptiScaler is **GPL-3.0** (its `LICENSE`, checked 2026-11-26 at upstream
  `a1e0e19`). Forge is BSD-3-Clause / MIT, so Forge **never ships or vendors
  OptiScaler**: the user's own PC downloads the official release at install
  time, the same way a user would by hand. Nothing in
  `py_modules/optiscaler.py` is taken from OptiScaler's code or from Clarity
  (GPL-3.0, Windows-native, AMD-only, used as reference only); the module is
  written from OptiScaler's public docs: the wiki's *Manual Installation*
  page and the `OptiScaler.ini` shipped with a release.
- Source of the download: `https://api.github.com/repos/optiscaler/OptiScaler/releases/latest`
  (the newest non-pre-release release; pre-releases and nightlies are never
  offered). Only an asset whose URL starts with
  `https://github.com/optiscaler/OptiScaler/releases/download/` is accepted.
- Asset: the first asset named `OptiScaler*.7z` (else `*.zip`), skipping
  debug / symbols / source builds. Releases publish a 7z such as
  `Optiscaler_0.9.0-final.20260401._AF.7z` (v0.9.0, as named in Decky-Framegen's
  release notes); latest tags at the time of writing are `v0.9.4` (July) and
  `v0.9.5` (2026-11-15). The exact asset list of v0.9.5 could not be read
  from here (GitHub's API was not reachable from the build machine), so the
  name match is deliberately loose. Unpacked with Forge's usual extractors
  (`_extract_sync`: 7-Zip / bsdtar).

### Hash

GitHub's API gives every release asset a `digest` (`sha256:<hex>`). When it
is there the download must match it, or it is deleted and nothing is
installed (`digest_mismatch`; accepting a change never overrides a published
digest). When it is not, the first hash Forge sees for that release asset
(`<tag>/<asset name>`) is pinned in `forge.json` (`optiscaler.pins`); the
same asset with a different hash later is refused with a warning, and the
game page asks *Install anyway?* before retrying with `accept_new_hash`
(re-pinned). The archive is kept in `runtime/optiscaler/<tag>/` (newest
release only), so reinstalling under another name or upscaler does not
download again; it is re-hashed every time.

### Anti-cheat: refused, no override

OptiScaler is a DLL loaded into the game's process; to an anti-cheat that is
injection. `optiscaler.refusal` refuses, with the crimson
**Not allowed: anti-cheat (DLL injection)** and no override button:

- every game the anti-cheat lock detects (the list, `EXTRA_GAMES`, and the
  anti-cheat files in the game folder), **including games where the user
  turned on "Allow mods anyway"**: the override is read as "detected", not
  "unlocked";
- the lock's `ONLINE_ONLY` games, and `optiscaler.COMPETITIVE` (Dota 2,
  Deadlock, Team Fortress 2, Counter-Strike, Counter-Strike: Source): ranked
  online VAC games the mod list leaves out on purpose. VAC bans injected
  DLLs (AMD's Anti-Lag+ got Counter-Strike 2 players banned in October 2023);
- a game Forge cannot identify (fails closed).

`forge_optiscaler_install` and `forge_optiscaler_set_upscaler` are also in
`_FORGE_GATED` (so `StructuralGateTests` and the Modded events see them), but
`_wrap_optiscaler_refusal` puts OptiScaler's own check outside the ordinary
lock so a locked game gets the OptiScaler wording. The refusal comes before
any download, backup or file work. Removal is never refused.

### Install

In order, each step able to stop it with nothing touched:

1. the refusal above;
2. the game folder (registered games, then Steam's app manifest) and its exe:
   the plugin's `processName` when the game is managed, else an Unreal
   `*-Win64-Shipping.exe`, else the biggest exe that is not a launcher, crash
   handler, installer or tool, outside `Engine/` and redistributable folders
   (`optiscaler.pick_exe`); the exe is remembered in the record;
3. *Close the game first* if it is running;
4. **DirectX check** from the exe's import table (`reloaded_ii.pe_info`):
   refused for a 32-bit exe or one that imports only DirectX 8/9 or OpenGL;
   `d3d12` / `d3d11` / `vulkan-1` are recorded; an exe that imports none
   (d3d12 loaded at run time, common in Unreal) is allowed;
5. **GPU check**: `Win32_VideoController` names and PnP ids through
   PowerShell (`CREATE_NO_WINDOW`, 20 s, cached a day). FSR 4 is offered only
   for RDNA 4 (Radeon RX 9000 / AI PRO R9000, PCI ids 7550/7551/7590), DLSS
   only on NVIDIA; FSR 3.1 and XeSS always. Default: FSR 4 on RDNA 4, DLSS on
   NVIDIA, XeSS on Arc, else FSR 3.1;
6. download and hash (above), unpack;
7. a **Ludusavi backup** of the saves (`_saves_backup`, the same switch and
   skip window as mod installs; a failed backup never stops the install). It
   is taken here, not by `_wrap_save_backups`, so a refused or failed check
   backs nothing up;
8. the files: a previous OptiScaler install of the game is taken out first
   (update, other upscaler, other name), then every file of the release goes
   next to the exe, `OptiScaler.dll` renamed to the proxy name, except the
   shipped `OptiScaler.ini` (Forge writes its own), `setup_windows.bat`,
   `setup_linux.sh`, the remove scripts and the "extract all files" readme.
   All or nothing: a failure part way removes what was copied and puts the
   originals back.

**Proxy name** (`optiscaler.choose_proxy`): `dxgi.dll`, `winmm.dll`,
`version.dll` in that order (dxgi is OptiScaler's preferred name; the wiki
also lists d3d12, dbghelp, wininet, winhttp and `.asi`, not offered). The
first name not present in the exe's folder wins. A ReShade DLL Forge put
there is never replaced; nor is a file that already has a `.nexusbak`
beside it (another mod's backup would be lost: the install is refused).
When all three are taken, the first one that is neither is replaced. The
game page offers **Use winmm.dll instead** (and so on round, under
**More...** on the Upscaling line) for games that do not load the current one.

**Backups**: any game file the install replaces (a `dxgi.dll`, the game's
own `libxess.dll` or `amd_fidelityfx_dx12.dll`, an older `OptiScaler.ini`)
is set aside as `<file>.nexusbak`, the files-mode backup every Forge
install uses, and listed in the record. The record lives in `forge.json`
under `optiscaler.games.<app id>`: every file with its SHA-256, the backups,
the folders created, the exe, the proxy, upscaler, version, asset, hash and
how it was checked.

**Remove** deletes each file only while it still has the hash Forge
recorded (a file another mod replaced since is left and named), puts every
`.nexusbak` back where the path is free (`_restore_backups`), and removes the
folders it created if empty. When something had to be left, the record keeps
just that, so Remove can be pressed again. The round-trip test compares the
whole game folder, byte for byte, before install and after removal.

### OptiScaler.ini

A minimal file, CRLF, only the keys Forge sets; every other key takes
OptiScaler's default (`auto`):

| Choice | `[Upscalers]` Dx11 / Dx12 / Vulkan | `[FSR] UpscalerIndex` |
|---|---|---|
| FSR 4 | `fsr31_12` / `fsr31` / `fsr31_12` | `0` (FSR 4) |
| FSR 3.1 | `fsr31` / `fsr31` / `fsr31` | `1` (FSR 3.1) |
| XeSS | `xess_12` / `xess` / `xess` | - |
| DLSS | `dlss` / `dlss` / `dlss` | - |

All three APIs are written because Forge cannot always tell which one a
game uses. The names are those of the v0.9.x releases (`fsr31`,
`fsr31_12`). OptiScaler's development branch renamed them `ffx` / `ffx_12`;
Forge reads the comment above `Dx12Upscaler=` in the release's own shipped
ini and uses `ffx` names when that is what it documents
(`optiscaler.upscaler_family`). `[Menu] DisableSplash=true` hides
OptiScaler's startup splash, its "press Insert" hint; the overlay itself
stays on Insert. **Upscaler...** on the game page rewrites only the ini.
The rarer actions (**Use winmm.dll instead** and so on, **Remove**) are under
**More...** on that line; a refused game's reason is behind **Why?**.

### Failure safety

`src/optiscaler.ts` sends the start and exit of every run of a game with
OptiScaler in (any game, managed or not) to the backend. Until the first
clean run after an install or update, a Windows Error Reporting crash report
for the exe (`forge_guard.wer_crashed`, the crash guard's check) or a run
under 60 seconds marks OptiScaler **suspect**: one toast (opens the game
page) and, on the Upscaling line, **Remove OptiScaler** (one press) and
**Keep it** (stops watching). A clean run ends the watch.

### Not verified on the PC yet

Everything here ran against fake files, a fake release and a fake extractor
on Linux. On the PC, check: that the real v0.9.5 asset is picked and its
GitHub digest matches; that the 7z unpacks with the bundled extractor; that
the game loads OptiScaler under `dxgi.dll` (Insert opens its menu even with
the splash hidden); that the minimal ini is honoured (the FSR 4 watermark,
`Fsr4EnableWatermark=true` added by hand, confirms FSR 4); that PowerShell
reports the GPU name; and that a game crash shows the removal offer.

## Load order (LOOT rules) and deploy profiles

For **Skyrim Special Edition, Fallout 4, Starfield and Oblivion
Remastered** only (Steam app ids 489830, 377160, 1716740, 2623190, or
their Nexus domains). Every other game shows nothing new. The game page's
Mods section gets one **Load order** line in its expanded view: how many
plugins are on, the current profile, problems in crimson and warnings in
amber, and three buttons: **Load order...** (the panel, which also says
where the rules came from), **Sort** (with LOOT rules) and **Profiles...**.
On an anti-cheat locked game only the panel is offered, and the backend refuses its writes anyway.

### The files, per game

| Game | Plugins file | Format | Not written (the game loads them itself) |
|---|---|---|---|
| Skyrim SE | `%LOCALAPPDATA%\Skyrim Special Edition\Plugins.txt` | every plugin in load order, `*` on the active ones | Skyrim, Update, Dawnguard, HearthFires, Dragonborn |
| Fallout 4 | `%LOCALAPPDATA%\Fallout4\Plugins.txt` | as Skyrim SE | Fallout4.esm and the seven DLC masters |
| Starfield | `%LOCALAPPDATA%\Starfield\Plugins.txt` | as Skyrim SE | Starfield, Constellation, OldMars, ShatteredSpace, SFBGS003/004/006/007/008/00D/047/050, and blueprint masters (flag 0x800) |
| Oblivion Remastered | `<game>\OblivionRemastered\Content\Dev\ObvData\Data\Plugins.txt` and `loadorder.txt` beside it | `Plugins.txt`: the active plugins in order, no markers; `loadorder.txt`: every plugin | nothing: Oblivion.esm and the DLC plugins stay listed |

These are the asterisk and text-file methods as libloadorder documents
them (its changelog for Oblivion Remastered, 18.4.0, and Starfield's
blueprint plugins, 18.6.0 / 18.8.0). Comment lines at the top of
`Plugins.txt` are kept, the file's line endings (CRLF / LF) and encoding
(UTF-8, else Windows-1252) are kept, and a line naming a plugin that is
not in Data is kept as it was. A `loadorder.txt` whose active plugins are
in a different order from `Plugins.txt` is ignored (the game reads
`Plugins.txt`). Every write first copies the old file to
`Plugins.txt.decky-bak` (and `loadorder.txt.decky-bak`); **Undo** on the
panel swaps them back (one step).

Plugin headers: the TES4 record's flags and MAST subrecords, a 24-byte
record header (20 for Oblivion Remastered, which uses Oblivion's format),
XXXX extended sizes handled. Master: flag 0x1, or a `.esm` / `.esl` name
(not on Oblivion Remastered, where only the flag counts). Light: 0x200 on
Skyrim SE and Fallout 4, 0x100 on Starfield, or a `.esl` name; Starfield
also has medium (0x400) and blueprint (0x800). Headers are cached by size
and date.

### Sorting

**Sort with LOOT rules** (`forge_lo_sort`), in `py_modules/load_order.py`,
pure Python, no LOOT binary:

1. **Hard rules**, never broken: a plugin after every master in its header;
   master files before the rest (except a plugin a master names in its
   header, which goes before that master, as the engine does); the
   masterlist's `after` and `req` entries for the plugin whose condition
   holds. Forge keeps masters first on Oblivion Remastered too, although
   that game would load them anywhere.
2. **Groups** from the masterlist (`group:` and the groups' `after`), as a
   soft rule: a plugin waits for the groups its group loads after, unless a
   hard rule needs it earlier.
3. **The current order** breaks every tie, so an order that already obeys
   the rules is left exactly as it is, and sorting twice moves nothing.
4. **Pins**: a pinned plugin is put back at its pinned position, as close
   as its hard rules allow (it never lands above its own master). When it
   cannot stay, the toast says where it went.

A **cycle** in the hard rules (two masterlist entries asking to load after
each other, plugins mastering each other, a master asked to load after a
plain plugin) is reported with the plugins in it, and **nothing is
written**. A cycle among the groups is reported and the groups are
ignored.

Not done, on purpose: LOOT's record-overlap rule (it reads every record of
every plugin to put the one that overrides more first), Bash Tags, the
userlist, and plugin ghosting. Conditions are evaluated three-valued:
`file()`, `readable()`, `active()`, `many()`, `many_active()`,
`is_master()` and `checksum()` are answered; `version()`,
`product_version()`, `file_size()` and the rest are "unknown". An unknown
condition hides its message and skips its rule rather than guessing.
Paths in conditions are confined to the game folder.

### Warnings

Only for plugins that are on: a master **not installed** or **switched
off** (crimson), a masterlist `req` that is missing (crimson) or off
(amber), an `inc` (incompatible) file or plugin that is present (crimson),
**dirty** plugins whose CRC-32 matches the masterlist's `dirty` entry
(amber: ITM / deleted references / deleted navmeshes, and the cleaning tool
it names), the masterlist's own `warn` / `error` messages for the plugin
whose condition holds, its global messages, and lines for plugins that are
not installed (amber). `say` messages are not shown. Markdown in messages
is shown as plain text. The CRC uses `zlib` (built into Windows CPython);
without it a pure-Python CRC runs for files up to 8 MB and larger ones are
not checked.

### The masterlist

Downloaded per game by the user's PC from LOOT's own repositories,
`https://raw.githubusercontent.com/loot/<repo>/v0.26/masterlist.yaml`
(LOOT 0.26's branch; `master` when that is missing), repos `skyrimse`,
`fallout4`, `starfield` and `oblivion-remastered`. Only URLs under
`https://raw.githubusercontent.com/loot/` are fetched, at most 8 MB.

- **Licence**: those four masterlists are **CC0 1.0** (each repository's
  `LICENSE`, checked 2026-11-26). Credit: masterlists by the LOOT team and
  contributors, https://github.com/loot. Forge never ships them; the
  tests use small synthetic masterlists. (LOOT's classic `oblivion`
  masterlist is GPL-3.0; Forge does not use it.) LOOT itself (GPL-3.0) and
  Amethyst Deploy (GPL-3.0) were reference only: no code was taken. The
  sort, the YAML reader and the formats were written from LOOT's metadata
  documentation and libloadorder's documentation and changelog.
- **Refresh**: at most once a day (a 304 with the saved ETag counts), and
  an hour after a failed try. **Offline**, the saved copy is used and the
  panel says so; with no copy at all, sorting uses headers and flags only,
  and says that too.
- **Cache**: `runtime/loot/<repo>.json`, the parts of the masterlist the
  sort uses (groups, per-plugin group / after / req / inc / msg / dirty,
  globals), so the YAML is parsed once a day at most. A download that does
  not parse keeps the old copy.
- **The YAML**: a small reader in `load_order.py` for what masterlists use
  (anchors, aliases, merge keys, quoted and multi-line scalars, flow
  collections, block scalars). On 2026-11-26 it read the four live
  masterlists and LOOT's prelude identically to PyYAML.

### The panel

The Load Order page in its one-game mode, opened from the game page
(`/nexus-mods/forge-load-order`; B goes back to the game page; no tabs).
Same controls as the Load Order tab: A picks a plugin up, the D-pad
carries it (LB / RB ten at a time), A puts it down, B puts it back; a
plugin cannot be carried above something it needs. ≡ (Options) switches a
plugin on or off, with its masters or its dependents. Each row shows its
worst warning (crimson or amber) and a pin when pinned; the right-hand
panel lists every warning and has **Pin its position** / **Unpin**. The
header has **Sort with LOOT rules**, **Undo** and **Profiles**, the
problem count and the masterlist line. No text entry anywhere except the
optional search field.

### Deploy profiles

Named per game (*Vanilla+*, *Full modlist*, *Light*, *Testing*, or a typed
name; 20 at most), kept in `forge.json` under `load_order.<app id>`:
`profiles.<name>` = the mods that are on, every mod the profile has seen,
the plugin order and the active plugins; `current`; and `pins`.

- **Saving**: *Save the current setup as a new profile...* (preset names
  need no typing; *Type a name* opens Steam's keyboard), or *Update
  <current>*.
- **Switching** (`src/ForgeLoadOrder.tsx`): refused while the game is
  running (Steam's running apps in the frontend, `tasklist` for the game's
  exe in the backend); the live state is saved into the current profile
  first, so profiles follow your changes; `forge_profile_plan` lists the
  mod switches (off first); a **Ludusavi backup** runs (the usual switch
  and skip window; a failed backup does not stop the switch, as for every
  mod change); the mods are switched one at a time through `install.ts`
  (`toggleMod`), the same calls as everywhere else, so the anti-cheat lock,
  the Modded collection and plugin activation all apply; then
  `forge_profile_apply_order` writes the profile's order and active
  plugins. Plugins the profile never saw keep their state at the end;
  masters an active plugin needs are switched on; a plugin whose master is
  missing or deliberately skipped stays off; skipped plugins whose master
  came back are released first (the 1.21.40 rule).
- Mods installed after a profile was saved are **off** in that profile (as
  in other mod managers' profiles), and the toast says how many. A mod the
  profile wants that is no longer installed is named.
- Deleting a profile changes nothing in the game.

The writers (`forge_lo_sort`, `forge_lo_set`, `forge_lo_undo`,
`forge_lo_set_active` and `forge_profile_apply_order`) are in
`_FORGE_GATED`: behind the anti-cheat lock, then a Ludusavi backup. Reads
(`forge_lo_status`, `forge_lo_get`, `forge_profile_plan`) and the
`forge.json` bookkeeping (`forge_lo_pin`, `forge_profile_save`,
`forge_profile_delete`) are on the structural test's allow-list.

### Not verified on the PC yet

Everything here ran on Linux against fake game folders, fixture plugin
bytes and synthetic masterlists; the real masterlists were only parsed
and sorted against made-up plugin sets. On the PC, check: that each
game's `Plugins.txt` is found where the table says (Skyrim SE from GOG or
Epic uses a different folder name and is not handled); that a LOOT sort of
a real modlist matches LOOT's own order closely (it will differ where
LOOT's overlap rule decides); that the game loads with the written file
(Starfield and Oblivion Remastered especially); that Oblivion Remastered
reads the rewritten `Plugins.txt` and ignores `loadorder.txt`; that the
running check refuses while the game is up; and that a profile switch
round trip on a real modlist leaves the game as it was.
