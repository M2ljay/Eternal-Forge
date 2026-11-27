# GameBanana: the second mod source

Written 24 November 2026 for 1.21.32-anygame.63. **Never run against the live
GameBanana API from the PC yet.** Everything below was built from GameBanana's
published Core API docs and from what other mod managers send, and tested
against synthetic answers shaped like them (`tests/test_gamebanana.py`).

## What the user gets

- **Store → "GameBanana · more mods for <game>"** opens the game's GameBanana
  mods: search, sort, load more, installed ones marked.
- **Linking the game.** A Steam game is linked to its GameBanana game by name
  when exactly one GameBanana game has the Steam name. Otherwise the page
  offers GameBanana's name matches, a game search, and a box for a
  `gamebanana.com/games/<id>` link or id. The link is remembered per Steam app
  id (`settings.json` → `gamebanana.games`); **Change game** forgets it.
  GameBanana does not publish Steam app ids, so there is no direct mapping.
- **A mod's page**: pictures, the description as plain text (only line
  breaks and list bullets survive; script, iframes and images from other
  hosts are dropped), the author's listed requirements (shown, not
  installed), and every file with size, date, downloads and GameBanana's own
  scan result.
- **Install** goes through `installModWith`, exactly like a Nexus mod: the
  game's own install mode, the folder-choice dialog, the FOMOD wizard,
  conflicts, Downloads tracking (pause, resume, cancel), restore points, the
  VR file guard, enable/disable and uninstall. No Nexus key is needed.
- **My Mods** tags the row "GameBanana"; its eye button opens the GameBanana
  page. Thumbnails come from GameBanana.
- **Updates**: a GameBanana mod shows as updatable when a newer upload of
  its file exists (rules below). Applying it installs that file.
- Adult (NSFW-flagged) mods follow the Nexus account's adult setting: hidden
  when adult content is off, blurred when blur is on.

## How it fits the pipeline

Everything in the install pipeline is keyed by integer mod and file ids
(archive cache, extract scratch, progress events, install records, restore
points). A GameBanana id is moved to `10^9 + id` (`gamebanana.to_local`)
before it reaches any of that. Nexus ids are far below 10^9, so they never
collide, and the Nexus-shaped calls answer for the moved range:

| Call | For a GameBanana mod |
|---|---|
| `_download_archive` | link from GameBanana instead of Nexus; same streaming, resume and pause; a fresh file that is an HTML page or fails GameBanana's MD5 is deleted and reported |
| `_install_mod_inner` | no "Not signed in" refusal |
| `install_mod` | after success, the record gets `gb_mod_id`, `gb_file_id`, `gb_file_date`, `source: "gamebanana"` |
| `get_mod_files` | the mod's GameBanana files, newest first, as MAIN files |
| `get_mods_by_ids` | name, thumbnail, likes from GameBanana |
| `get_mod_details` | refused (`gamebanana: true`); pages open the GameBanana page |
| `match_file_to_game` | file 0 (no Nexus lookup) |
| `check_updates` | excluded from the Nexus query, checked against GameBanana and merged |
| `_legacy_mods_in_batches` | ids in the range are dropped, so nothing asks Nexus about them |

## Endpoints used

| Use | Endpoint | Standing |
|---|---|---|
| Mod list for a game | `gamebanana.com/apiv11/Mod/Index?_nPage=&_nPerpage=24&_aFilters[Generic_Game]=<game>` (+ `_sSort=`) | Undocumented but what the site and several mod managers use (`/Sound/Index` with the same filter is used by ZZAR). The `_sSort` names (`Generic_Newest`, `Generic_LatestUpdated`, `Generic_MostLiked`, `Generic_MostDownloaded`, `Generic_MostViewed`) are **unverified**: a sort the server rejects falls back to the default order and the page says so |
| Search | `apiv11/Util/Search/Results?_sModelName=Mod&_sOrder=best_match&_idGameRow=<game>&_sSearchString=` | Undocumented; **unverified** |
| Mod page | `apiv11/Mod/<id>/ProfilePage` | Undocumented; field names (`_aFiles`, `_nLikeCount`, `_tsDateUpdated`, `_aRequirements`, …) confirmed in another manager's code |
| Files of many mods (updates) | `api.gamebanana.com/Core/Item/Data?itemtype[]=Mod&itemid[]=<id>&fields[]=Files().aFiles()` (multicall, 20 per request) | **Documented** at api.gamebanana.com. Mods it does not answer for are read from their ProfilePage instead |
| Game name by id (manual link) | `Core/Item/Data?itemtype=Game&itemid=<id>&fields=name&return_keys=1` | Documented endpoint; the `name` field for Game is assumed |
| Games by name | `apiv11/Util/Game/NameMatch?_sName=` | Undocumented; **unverified**. If it fails, linking by link/id still works |
| Download | the file's `_sDownloadUrl`, else `https://gamebanana.com/dl/<file id>` | Redirects to files.gamebanana.com; no session. Only https links on gamebanana.com hosts are followed |

Politeness: one shared HTTP session, the plugin's User-Agent
(`decky-nexus/<version>`), at most 4 GameBanana requests at once, lists and
mod pages cached 10 minutes, game matches a day; HTTP 429/5xx and HTML
answered instead of JSON (Cloudflare pages come back 200) are retried twice
with backoff; 404 and other errors become a message in the plugin's usual
`{ok: false, error}` shape. GameBanana's MD5 field is often empty; the
download is only checked against it when present.

## Update rules (`gamebanana.update_for`)

- Baseline: the installed file's upload date (from GameBanana's list, else
  `gb_file_date` on the record, else when it was installed).
- A file counts as newer when uploaded more than 2 minutes after the
  baseline; variant packs uploaded together are not updates of each other.
- If the installed file is still on the page, only a newer file with the same
  name stem (version numbers and extension removed: `skin_v1.zip` ~
  `skin_v2.7z`) is its update. If it was deleted, the newest newer file is.
- **Dismiss** works as for Nexus mods (`ignore_update` matched against the
  offered "current").

## ROM games from The Collector

Added in 1.21.40-anygame.72. GameBanana lists games per title, and many
emulated games' mods (texture packs, Riivolution, `romfs` mods, soft patches)
live there. A ROM page from The Collector gets the GameBanana mods of its
game (see [forge.md](forge.md#rom-games-the-collector) for the install path).

### Matching a ROM to its GameBanana game (`py_modules/rom_mods.py`)

- The ROM's name loses its region and revision tags (`Super Mario Sunshine
  (USA) (Rev 1)` -> `Super Mario Sunshine`), then GameBanana's name search
  (`NameMatch`, unverified like the rest) is asked for the title and, for a
  mapped platform, the title with the platform's name (`Metroid Prime
  GameCube`).
- Candidates are ranked (`rank_candidates`): the same title with a platform
  tag naming this system (`(GC)`, `... Wii`) scores 100, the same title with
  no tag 90, the same title tagged for **another** system 40 (kept, ranked
  low: the user decides), a title sharing words 20-40. GameBanana's search
  does not filter by platform, so the platform ranks and breaks ties, and
  never drops a candidate.
- A link is made by itself only when exactly one candidate scores 90 or
  more (`auto_pick`). Otherwise the page offers the ranked candidates (those
  matching the platform say so), a search, and a `gamebanana.com/games/<id>`
  link or id: the same manual flow as for Steam games. The link is kept per
  app id in `settings.json` (`gamebanana.games`), like a Steam game's.

### Platform slugs mapped

RomM's slugs as The Collector passes them (`platformSlug`):

| Slug(s) | Name | Tags recognised in a GameBanana game name |
|---|---|---|
| `ngc`, `gc`, `gamecube` | GameCube | GameCube, GC, GCN, NGC |
| `wii` | Wii | Wii |
| `wiiu` | Wii U | Wii U, WiiU |
| `switch` | Switch | Switch, Nintendo Switch, NX |
| `3ds`, `n3ds` | 3DS | 3DS, New 3DS, Nintendo 3DS |
| `nds` | DS | NDS, DS, Nintendo DS |
| `n64` | Nintendo 64 | N64, Nintendo 64 |
| `snes`, `sfam` | SNES | SNES, Super Nintendo, SFC, Super Famicom |
| `nes`, `famicom` | NES | NES, Famicom |
| `gba` | Game Boy Advance | GBA, Game Boy Advance |
| `gbc` | Game Boy Color | GBC, Game Boy Color |
| `gb` | Game Boy | GB, Game Boy |
| `psx`, `ps1` | PlayStation | PS1, PSX, PlayStation |
| `ps2` | PlayStation 2 | PS2, PlayStation 2 |
| `ps3` | PlayStation 3 | PS3, PlayStation 3 |
| `psp` | PSP | PSP, PlayStation Portable |
| `psvita` | PS Vita | Vita, PS Vita |
| `genesis-slash-megadrive`, `megadrive`, `genesis` | Genesis | Genesis, Mega Drive, MD |
| `dc`, `dreamcast` | Dreamcast | Dreamcast, DC |
| `saturn` | Saturn | Saturn |
| `xbox` | Xbox | Xbox |
| `xbox360` | Xbox 360 | Xbox 360, X360 |

**Unmapped** (matched by name only, the picker says so): arcade boards
(`arcade`, `neogeoaes`, ...), `atari2600` and other Atari systems, `pce`
(PC Engine), `msx`, `wonderswan`, `ngp`, `3do`, `jaguar`, `lynx`, and any
slug not in the table. GameBanana has little or nothing for these; add a row
to `PLATFORMS` when one turns out to have a section.

Which of these The Collector can actually install for depends on the
emulator the ROM launches with (Dolphin, PPSSPP, PCSX2, Azahar/Citra,
RetroArch soft patches today); the card says when there is no mod folder.

### Downloading for a ROM

The file is downloaded like any GameBanana file (same cache, progress,
pause, MD5 check, HTML-page check), then saved at the top of
`%USERPROFILE%\Downloads` under its own name for The Collector to preview
and install (`forge_rom_stage`). `.7z` and `.rar` are unpacked into a folder
first, because The Collector reads only `.zip`. Updates use `update_for`
against the record Forge keeps for the ROM (`runtime/forge-rom-mods.json`).

### Mod kinds (anygame.73)

GameBanana files for a ROM go only to The Collector's **Mods** targets
(`files`, `layeredFs`, `graphicsMods`, `riivolution`); a cheat file
(`.txt`, `.pnach`, `.cht`) only to the `cheats` target. Toggle lists take no
file. Cheats come from their own sources (see
[forge.md](forge.md#cheat-sources-py_modulesrom_cheatspy-forge_rom_cheat_)),
not from GameBanana (PS2 `.pnach` from GameHacking.org since anygame.74,
personal use pending permission).

## Not done / to check on the PC

- The unverified endpoints above, against the live site (sorts, search,
  NameMatch, Core answer shape for `Files().aFiles()`).
- That `/dl/<id>` downloads without a browser challenge from the PC.
- Collections, endorsements and Nexus requirement chips do not apply to
  GameBanana mods. The pre-install "VR files in this archive" warning is
  Nexus-only (the VR guard itself applies to every install).
- GameBanana's 1-click (`mmdl`) links are not registered.
- The ROM matching above against real GameBanana game names (how often a
  platform tag appears, whether NameMatch finds `<title> <platform>`).
