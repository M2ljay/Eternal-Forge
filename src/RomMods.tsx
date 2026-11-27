// Forge's Mods tab and Overview card on The Collector's ROM pages.
//
// Rendered from The Collector's tree through window.__eternalGamePage, with
// the one React instance Steam's UI shares (window.SP_REACT, which @decky's
// rollup config maps `react` to), inside an error boundary. Mod sources:
// GameBanana (games per platform, matched by name and the ROM's platform,
// with a manual "pick the game"), Nexus Mods where a game page exists, and
// the user's own files in Downloads. Installing goes through The Collector's
// preview and install (collectorBridge.runRomInstall); Forge remembers what
// it installed (py_modules/rom_mods.py) for the card and for updates.
import { ButtonItem, ConfirmModal, DialogButton, Focusable, ModalRoot, TextField, showModal } from "@decky/ui";
import { toaster } from "@decky/api";
import { Component, ErrorInfo, ReactNode, useEffect, useRef, useState } from "react";

import {
  ExperimentalCandidate,
  GbGame,
  GbModSummary,
  ModFile,
  NexusMod,
  RomLinks,
  RomModRecord,
  RomUpdate,
  forgeRomForget,
  forgeRomLink,
  forgeRomMods,
  forgeRomRecord,
  forgeRomSetNexus,
  forgeRomStage,
  forgeRomUnstage,
  forgeRomUpdates,
  gbLinkGame,
  gbListMods,
  gbSearchGames,
  getModFiles,
  getMods,
  searchNexusGames,
} from "./api";
import {
  CollectorModsApi,
  FORGE_CARD_ID,
  FORGE_EXT_ID,
  GamePageExtension,
  ModPreview,
  ModTarget,
  RomInstallArgs,
  RomModFile,
  RomPageContext,
  RomSource,
  failure,
  fileKind,
  isOk,
  readCollectorMods,
  romCardSummary,
  runRomInstall,
  runRomRemove,
  targetsFor,
} from "./collectorBridge";
import { CARD_TEXT, FORGE_CRIMSON, FORGE_GUNMETAL, FORGE_STEEL, MODS_TAB_TITLE } from "./forgeRules";
import { fmtBytes } from "./gamebanana";
import { Prompt, UpdatesChip } from "./GameModsSection";
import { AMBER, CRIMSON_TEXT, GREEN, STEEL_MUTED, WHITE } from "./palette";

const win = (): any => globalThis as any;
const bridge = (): CollectorModsApi | undefined => readCollectorMods(win());

// ---- Shared per-ROM state ---------------------------------------------------
// The card and the tab read the same answers; one fetch serves both, and any
// change (install, remove, update) refreshes every subscriber.

interface RomState {
  records?: RomModRecord[];
  updates: Record<string, RomUpdate>;
  targets?: any;
  links?: RomLinks;
}

const states = new Map<number, RomState>();
const listeners = new Map<number, Set<() => void>>();

function emit(appId: number): void {
  for (const fn of [...(listeners.get(appId) ?? [])]) {
    try {
      fn();
    } catch {
      // one subscriber's failure must not stop the others
    }
  }
}

function patch(appId: number, part: Partial<RomState>): void {
  states.set(appId, { updates: {}, ...(states.get(appId) ?? {}), ...part });
  emit(appId);
}

async function refreshRom(appId: number, withUpdates = false): Promise<void> {
  const b = bridge();
  const tasks: Promise<unknown>[] = [
    forgeRomMods(appId)
      .then((r) => patch(appId, { records: r.mods ?? [] }))
      .catch(() => patch(appId, { records: [] })),
  ];
  if (b) {
    tasks.push(
      Promise.resolve(b.getTargets(appId))
        .then((t) => patch(appId, { targets: t }))
        .catch((e) => patch(appId, { targets: { success: false, reason: "error", message: String(e) } }))
    );
  }
  if (withUpdates) {
    tasks.push(
      forgeRomUpdates(appId)
        .then((r) => patch(appId, { updates: r.updates ?? {} }))
        .catch(() => undefined)
    );
  }
  await Promise.all(tasks);
}

/** The ROM's state. Re-read when The Collector's page switches to another
 * version of the game (same app id, new rom id): its targets follow the
 * game file. Forge's records carry the rom id they were installed for. */
function useRom(appId: number, romId: number, withUpdates: boolean): RomState {
  const [, tick] = useState(0);
  useEffect(() => {
    const set = listeners.get(appId) ?? new Set();
    const fn = () => tick((n) => n + 1);
    set.add(fn);
    listeners.set(appId, set);
    patch(appId, { targets: undefined });
    void refreshRom(appId, withUpdates);
    return () => {
      set.delete(fn);
    };
  }, [appId, romId]);
  const st = states.get(appId) ?? { updates: {} };
  const records = st.records?.filter((r) => !r.rom_id || !romId || r.rom_id === romId);
  return { ...st, records };
}

// ---- Small pieces -------------------------------------------------------------

class RomBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    console.error("Forge on The Collector's page: render failed", error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const TONE: Record<string, string> = { ok: GREEN, warn: AMBER, error: CRIMSON_TEXT, hint: STEEL_MUTED };

function line(text: ReactNode, color: string = FORGE_STEEL) {
  return (
    <div style={{ color, fontSize: `${CARD_TEXT.body}px`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      {text}
    </div>
  );
}

function sourceName(s: RomSource): string {
  return s === "gamebanana" ? "GameBanana" : s === "nexus" ? "Nexus Mods" : "Your file";
}

function refusalModal(title: string, reason: string, message: string): void {
  showModal(
    <ConfirmModal strTitle={title} strDescription={`${message}${reason && reason !== "refused" ? ` (${reason})` : ""}`} bAlertDialog strOKButtonText="Close" />
  );
}

// ---- Choosing ------------------------------------------------------------------

/** A list of choices in a modal; resolves with the pick or undefined. */
function choose<T>(title: string, items: { label: string; description?: string; value: T }[], note?: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | undefined) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    showModal(<ChooseModal title={title} note={note} items={items} onPick={finish} />);
  });
}

function ChooseModal<T>({
  title,
  note,
  items,
  onPick,
  closeModal,
}: {
  title: string;
  note?: string;
  items: { label: string; description?: string; value: T }[];
  onPick: (v: T | undefined) => void;
  closeModal?: () => void;
}) {
  return (
    <ModalRoot
      closeModal={() => {
        onPick(undefined);
        closeModal?.();
      }}
    >
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {note && <div style={{ fontSize: "13px", color: STEEL_MUTED, marginBottom: "8px" }}>{note}</div>}
      {items.map((it, i) => (
        <ButtonItem
          key={i}
          layout="below"
          description={it.description}
          onClick={() => {
            onPick(it.value);
            closeModal?.();
          }}
        >
          {it.label}
        </ButtonItem>
      ))}
    </ModalRoot>
  );
}

/** The target a file goes to: one fitting target is used as is. */
async function pickTarget(appId: number, fileName: string): Promise<ModTarget | undefined> {
  const b = bridge();
  if (!b) return undefined;
  const t = await b.getTargets(appId);
  if (!isOk(t)) {
    const f = failure(t, "No known mod folder for this emulator");
    refusalModal("No place for mods", f.reason, f.message);
    return undefined;
  }
  const fits = targetsFor(t.targets ?? [], fileKind(fileName));
  if (!fits.length) {
    refusalModal(
      "Nowhere to put this file",
      "",
      fileKind(fileName) === "patch"
        ? "This is a soft patch, and the emulator this game launches with takes none."
        : "The emulator this game launches with has no folder for this kind of mod."
    );
    return undefined;
  }
  if (fits.length === 1) return fits[0];
  return choose(
    "Where does it go?",
    fits.map((x) => ({ label: x.label, description: [x.scope, ...(x.notes ?? [])].filter(Boolean).join(" · "), value: x }))
  );
}

/** The Collector's preview, shown before anything is written. */
function confirmPreview(p: ModPreview, entry: string): Promise<boolean> {
  return new Promise((resolve) => {
    const writes = p.writes ?? [];
    const body = (
      <div style={{ fontSize: "14px", lineHeight: 1.45 }}>
        <div>
          {p.write_count ?? writes.length} file{(p.write_count ?? writes.length) === 1 ? "" : "s"},{" "}
          {fmtBytes(Number(p.total_bytes ?? 0))}, from <b>{entry}</b>
        </div>
        {p.destination && <div style={{ color: STEEL_MUTED }}>Into {p.destination}</div>}
        {p.stripped_folder && <div style={{ color: STEEL_MUTED }}>Its top folder {p.stripped_folder} is the game's own, so its contents go straight in.</div>}
        {(p.replace_count ?? 0) > 0 ? (
          <div style={{ color: AMBER }}>
            Replaces {p.replace_count} existing file{p.replace_count === 1 ? "" : "s"}; they are moved to The Collector's backup
            folder first{p.backup_root ? ` (${p.backup_root})` : ""}.
          </div>
        ) : (
          <div style={{ color: GREEN }}>Replaces nothing.</div>
        )}
        {writes.slice(0, 8).map((w) => (
          <div key={w.path} style={{ color: w.replaces ? AMBER : FORGE_STEEL, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {w.replaces ? "replaces " : ""}
            {w.path}
          </div>
        ))}
        {writes.length > 8 && <div style={{ color: STEEL_MUTED }}>and {writes.length - 8} more</div>}
      </div>
    );
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    showModal(
      <ConfirmModal
        strTitle="Install this mod?"
        strDescription={body as any}
        strOKButtonText="Install"
        strCancelButtonText="Cancel"
        onOK={() => finish(true)}
        onCancel={() => finish(false)}
        closeModal={() => finish(false)}
      />
    );
  });
}

/** Download (if needed), preview, install, record; refusals are shown. */
async function installFor(ctx: RomPageContext, args: Omit<RomInstallArgs, "appId" | "romId" | "target">, fileName: string, target?: ModTarget) {
  const b = bridge();
  if (!b) return;
  const t = target ?? (await pickTarget(ctx.appId, fileName));
  if (!t) return;
  toaster.toast({ title: "Forge", body: args.source === "local" ? "Reading the preview..." : "Downloading..." });
  const res = await runRomInstall(
    {
      bridge: b,
      stage: (file: RomModFile, source: RomSource, folder: string) =>
        forgeRomStage(ctx.appId, source, file.mod_id, file.file_id, file.file_name, file.name, folder, file.domain ?? ""),
      unstage: (entry: string, folder: string) => forgeRomUnstage(entry, folder),
      record: (rec) => forgeRomRecord(ctx.appId, rec),
      confirm: confirmPreview,
    },
    { ...args, appId: ctx.appId, romId: ctx.romId, target: { target_id: t.target_id, label: t.label } }
  );
  if (res.ok) {
    toaster.toast({
      title: "Mod installed",
      body: `${res.written} file${res.written === 1 ? "" : "s"} written${res.backedUp ? `, ${res.backedUp} backed up` : ""}.`,
    });
  } else if (res.step !== "cancelled") {
    const titles: Record<string, string> = {
      sources: "The Collector can't read Downloads",
      download: "Download failed",
      preview: "The Collector refused this mod",
      install: "The Collector did not install it",
      record: "Installed, not remembered",
    };
    refusalModal(titles[res.step] ?? "Not installed", res.reason, res.message);
  }
  await refreshRom(ctx.appId, true);
}

// ---- Sources ---------------------------------------------------------------------

async function links(ctx: RomPageContext, fresh = false): Promise<RomLinks> {
  const cur = states.get(ctx.appId)?.links;
  if (cur && !fresh) return cur;
  const r = await forgeRomLink(ctx.appId, ctx.name, ctx.platformSlug);
  patch(ctx.appId, { links: r });
  return r;
}

/** GameBanana: link the game (by itself, or picked), then its mods. */
async function fromGameBanana(ctx: RomPageContext): Promise<void> {
  const l = await links(ctx);
  let game: GbGame | null | undefined = l.gamebanana?.linked;
  if (!game) {
    game = await pickGbGame(ctx, l);
    if (!game) return;
    patch(ctx.appId, { links: undefined });
  }
  showModal(<GbModsModal ctx={ctx} game={game} />);
}

function pickGbGame(ctx: RomPageContext, l: RomLinks): Promise<GbGame | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (g: GbGame | undefined) => {
      if (!done) {
        done = true;
        resolve(g);
      }
    };
    showModal(<GbPickModal ctx={ctx} links={l} onDone={finish} />);
  });
}

function GbPickModal({ ctx, links: l, onDone, closeModal }: { ctx: RomPageContext; links: RomLinks; onDone: (g: GbGame | undefined) => void; closeModal?: () => void }) {
  const [query, setQuery] = useState(ctx.name);
  const [found, setFound] = useState<GbGame[] | undefined>();
  const [ref, setRef] = useState("");
  const [note, setNote] = useState(l.gamebanana?.error ?? "");
  const cands = found ?? l.gamebanana?.candidates ?? [];
  const link = async (r: string, name = "") => {
    const res = await gbLinkGame(ctx.appId, r, name);
    if (!res.ok || !res.linked) {
      setNote(res.error ?? "Not linked");
      return;
    }
    onDone(res.linked);
    closeModal?.();
  };
  const platform = l.platform?.mapped ? l.platform.name : ctx.platformName;
  return (
    <ModalRoot closeModal={() => (onDone(undefined), closeModal?.())}>
      <h3 style={{ marginTop: 0 }}>Which GameBanana game is {ctx.name}?</h3>
      <div style={{ fontSize: "13px", color: STEEL_MUTED, marginBottom: "8px" }}>
        {platform ? `${platform}. ` : ""}GameBanana lists games per title; pick the one for this system. Forge remembers it.
        {l.platform && !l.platform.mapped ? " (This system has no GameBanana mapping in Forge: matched by name only.)" : ""}
      </div>
      {cands.map((c: any) => (
        <ButtonItem
          key={c.id}
          layout="below"
          description={c.platform_match ? `Matches ${platform}` : undefined}
          onClick={() => void link(String(c.id), c.name)}
        >
          {c.name}
        </ButtonItem>
      ))}
      {!cands.length && <div style={{ color: STEEL_MUTED, margin: "4px 0" }}>No GameBanana game matched its name.</div>}
      <TextField label="Search GameBanana games" value={query} onChange={(e: any) => setQuery(e.target.value)} />
      <ButtonItem
        layout="below"
        onClick={async () => {
          const r = await gbSearchGames(query);
          setFound(r.ok ? r.games ?? [] : []);
          if (!r.ok) setNote(r.error ?? "Search failed");
        }}
      >
        Search
      </ButtonItem>
      <TextField label="Or a gamebanana.com/games/... link or id" value={ref} onChange={(e: any) => setRef(e.target.value)} />
      <ButtonItem layout="below" disabled={!ref.trim()} onClick={() => void link(ref.trim())}>
        Link this game
      </ButtonItem>
      {note && <div style={{ color: CRIMSON_TEXT, fontSize: "13px" }}>{note}</div>}
    </ModalRoot>
  );
}

function GbModsModal({ ctx, game, closeModal }: { ctx: RomPageContext; game: GbGame; closeModal?: () => void }) {
  const [mods, setMods] = useState<GbModSummary[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = async (p: number, q: string) => {
    setLoading(true);
    try {
      const r = await gbListMods("", ctx.appId, p, "default", q);
      if (!r.ok) {
        setError(r.error ?? "GameBanana did not answer");
        return;
      }
      setError("");
      setMods((m) => (p === 1 ? r.mods ?? [] : [...m, ...(r.mods ?? [])]));
      setPage(p);
      setMore(Boolean(r.has_more));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(1, "");
  }, []);
  return (
    <ModalRoot closeModal={closeModal}>
      <h3 style={{ marginTop: 0 }}>GameBanana · {game.name}</h3>
      <TextField label="Search this game's mods" value={search} onChange={(e: any) => setSearch(e.target.value)} />
      <ButtonItem layout="below" disabled={loading} onClick={() => void load(1, search)}>
        Search
      </ButtonItem>
      {error && <div style={{ color: CRIMSON_TEXT }}>{error}</div>}
      {mods.map((m) => (
        <ButtonItem
          key={m.gb_id}
          layout="below"
          description={`${m.author} · ${m.likes} likes · ${m.downloads.toLocaleString()} downloads${m.category ? ` · ${m.category}` : ""}`}
          onClick={() => {
            closeModal?.();
            void pickFileAndInstall(ctx, "gamebanana", m.mod_id, m.name, "");
          }}
        >
          {m.name}
        </ButtonItem>
      ))}
      {loading && <div style={{ color: STEEL_MUTED }}>Loading...</div>}
      {more && !loading && (
        <ButtonItem layout="below" onClick={() => void load(page + 1, search)}>
          More
        </ButtonItem>
      )}
    </ModalRoot>
  );
}

/** Nexus Mods: the ROM's game page there (linked, matched, or searched). */
async function fromNexus(ctx: RomPageContext): Promise<void> {
  const l = await links(ctx);
  let domain = l.nexus?.linked?.domain;
  let name = l.nexus?.linked?.name ?? "";
  if (!domain) {
    const picked = await new Promise<ExperimentalCandidate | undefined>((resolve) =>
      showModal(<NexusPickModal ctx={ctx} candidates={l.nexus?.candidates ?? []} onDone={resolve} />)
    );
    if (!picked) return;
    const r = await forgeRomSetNexus(ctx.appId, picked.domain, picked.name);
    if (!r.ok) {
      toaster.toast({ title: "Not linked", body: r.error ?? "" });
      return;
    }
    domain = picked.domain;
    name = picked.name;
    patch(ctx.appId, { links: undefined });
  }
  showModal(<NexusModsModal ctx={ctx} domain={domain} name={name} />);
}

function NexusPickModal({
  ctx,
  candidates,
  onDone,
  closeModal,
}: {
  ctx: RomPageContext;
  candidates: ExperimentalCandidate[];
  onDone: (c: ExperimentalCandidate | undefined) => void;
  closeModal?: () => void;
}) {
  const [query, setQuery] = useState(ctx.name);
  const [found, setFound] = useState<ExperimentalCandidate[] | undefined>();
  const [note, setNote] = useState("");
  const list = found ?? candidates;
  return (
    <ModalRoot closeModal={() => (onDone(undefined), closeModal?.())}>
      <h3 style={{ marginTop: 0 }}>Which Nexus Mods game is {ctx.name}?</h3>
      <div style={{ fontSize: "13px", color: STEEL_MUTED, marginBottom: "8px" }}>
        Few emulated games have a Nexus Mods page. Pick it if it has one; GameBanana and your own files work either way.
      </div>
      {list.map((c) => (
        <ButtonItem
          key={c.domain}
          layout="below"
          description={c.mods ? `${c.mods.toLocaleString()} mods · ${c.domain}` : c.domain}
          onClick={() => {
            onDone(c);
            closeModal?.();
          }}
        >
          {c.name}
        </ButtonItem>
      ))}
      <TextField label="Search Nexus Mods games" value={query} onChange={(e: any) => setQuery(e.target.value)} />
      <ButtonItem
        layout="below"
        onClick={async () => {
          const r = await searchNexusGames(query);
          setFound(r.ok ? r.games ?? [] : []);
          setNote(!r.ok ? r.error ?? "Search failed" : (r.games ?? []).length ? "" : "No Nexus Mods game by that name.");
        }}
      >
        Search
      </ButtonItem>
      {note && <div style={{ color: STEEL_MUTED, fontSize: "13px" }}>{note}</div>}
    </ModalRoot>
  );
}

function NexusModsModal({ ctx, domain, name, closeModal }: { ctx: RomPageContext; domain: string; name: string; closeModal?: () => void }) {
  const [mods, setMods] = useState<NexusMod[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = async (from: number, q: string) => {
    setLoading(true);
    try {
      const r = await getMods(domain, "endorsements", 20, from, q, ctx.appId);
      if (!r.ok) {
        setError((r as any).error ?? "Nexus Mods did not answer");
        return;
      }
      setError("");
      setMods((m) => (from === 0 ? r.mods ?? [] : [...m, ...(r.mods ?? [])]));
      setOffset(r.next_offset ?? from + (r.mods?.length ?? 0));
      setTotal(r.total ?? 0);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(0, "");
  }, []);
  return (
    <ModalRoot closeModal={closeModal}>
      <h3 style={{ marginTop: 0 }}>Nexus Mods · {name}</h3>
      <TextField label="Search this game's mods" value={search} onChange={(e: any) => setSearch(e.target.value)} />
      <ButtonItem layout="below" disabled={loading} onClick={() => void load(0, search)}>
        Search
      </ButtonItem>
      {error && <div style={{ color: CRIMSON_TEXT }}>{error}</div>}
      {mods.map((m) => (
        <ButtonItem
          key={m.modId}
          layout="below"
          description={`${m.author} · ${m.endorsements.toLocaleString()} endorsements · v${m.version}`}
          onClick={() => {
            closeModal?.();
            void pickFileAndInstall(ctx, "nexus", m.modId, m.name, domain);
          }}
        >
          {m.name}
        </ButtonItem>
      ))}
      {loading && <div style={{ color: STEEL_MUTED }}>Loading...</div>}
      {!loading && offset < total && (
        <ButtonItem layout="below" onClick={() => void load(offset, search)}>
          More
        </ButtonItem>
      )}
    </ModalRoot>
  );
}

/** A mod's files (GameBanana or Nexus), then the install. */
async function pickFileAndInstall(ctx: RomPageContext, source: "gamebanana" | "nexus", modId: number, modName: string, domain: string, keep?: RomModRecord) {
  const r = await getModFiles(domain, modId);
  if (!r.ok || !(r.files ?? []).length) {
    refusalModal("No files", "", r.error ?? "This mod has no downloadable file.");
    return;
  }
  const files = (r.files ?? []).filter((f) => !/^(OLD_VERSION|ARCHIVED|DELETED)$/i.test(f.category_name));
  const file: ModFile | undefined =
    files.length === 1
      ? files[0]
      : await choose(
          modName,
          files.map((f) => ({
            label: f.name,
            description: [f.version && `v${f.version}`, f.size_kb ? fmtBytes(f.size_kb * 1024) : "", f.file_name].filter(Boolean).join(" · "),
            value: f,
          })),
          "Pick the file to install."
        );
  if (!file) return;
  await installFor(
    ctx,
    {
      source,
      file: {
        mod_id: modId,
        file_id: file.file_id,
        file_name: file.file_name,
        name: modName,
        version: file.version,
        date: Number((file as any).uploaded_timestamp ?? 0),
        domain,
      },
      keepEntries: keep?.entries,
    },
    file.file_name
  );
}

/** The user's own files: the top of Downloads, as The Collector lists it
 * for the target picked first (a soft-patch target lists only patches). */
async function fromDownloads(ctx: RomPageContext): Promise<void> {
  const b = bridge();
  if (!b) return;
  const t = await b.getTargets(ctx.appId);
  if (!isOk(t)) {
    const f = failure(t, "No known mod folder for this emulator");
    refusalModal("No place for mods", f.reason, f.message);
    return;
  }
  const all: ModTarget[] = t.targets ?? [];
  const target =
    all.length === 1
      ? all[0]
      : await choose(
          "Install into which folder?",
          all.map((x) => ({ label: x.label, description: [x.scope, ...(x.notes ?? [])].filter(Boolean).join(" · "), value: x }))
        );
  if (!target) return;
  const s = await b.listSources(ctx.appId, target.target_id);
  if (!isOk(s)) {
    const f = failure(s);
    refusalModal("The Collector can't read Downloads", f.reason, f.message);
    return;
  }
  const entries = (s.entries ?? []) as { name: string; kind?: string; supported?: boolean; size?: number | null }[];
  const usable = entries.filter((e) => e.supported !== false);
  if (!usable.length) {
    refusalModal(
      "Nothing to install in Downloads",
      "",
      target.accepts === "patch"
        ? "Put the soft patch (.ips, .bps, .ups, or a .zip holding one) at the top of your Downloads folder."
        : "Put a .zip or a folder at the top of your Downloads folder. .7z and .rar must be extracted first."
    );
    return;
  }
  const pick = await choose(
    `Install into ${target.label}`,
    usable.slice(0, 40).map((e) => ({
      label: e.name,
      description: [e.kind, e.size ? fmtBytes(e.size) : ""].filter(Boolean).join(" · "),
      value: e,
    })),
    entries.length > usable.length ? `${entries.length - usable.length} item(s) can't be read (extract .7z/.rar first).` : undefined
  );
  if (!pick) return;
  await installFor(ctx, { source: "local", entry: pick.name }, pick.name, target);
}

// ---- The tab ----------------------------------------------------------------------

function RomModsTab({ ctx }: { ctx: RomPageContext }) {
  const st = useRom(ctx.appId, ctx.romId, true);
  const b = bridge();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toaster.toast({ title: "Forge", body: String(e) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const records = st.records ?? [];
  const summary = romCardSummary({
    installed: ctx.installed,
    records,
    updates: Object.keys(st.updates).length,
    targets: st.targets,
    bridge: Boolean(b),
  });
  const targets: ModTarget[] = isOk(st.targets) ? st.targets.targets ?? [] : [];
  const can = Boolean(b) && ctx.installed && targets.length > 0;
  const settingOff = targets.find((t) => t.setting && t.setting.state === "off" && t.setting.can_enable);

  const remove = (rec: RomModRecord) =>
    showModal(
      <ConfirmModal
        strTitle={`Remove ${rec.name}?`}
        strDescription={
          rec.entries.length
            ? `The Collector moves ${rec.entries.join(", ")} from ${rec.target_label || "the mod folder"} to its backup folder. Nothing is deleted.`
            : "Forge doesn't know which files this mod added; remove it in The Collector's Mods panel."
        }
        strOKButtonText="Remove"
        strCancelButtonText="Cancel"
        onOK={() =>
          void run(async () => {
            if (!b) return;
            const r = await runRomRemove(b, ctx.appId, rec, (id) => forgeRomForget(ctx.appId, id));
            if (r.ok) toaster.toast({ title: "Mod removed", body: r.backupFolder ? `Backed up to ${r.backupFolder}` : r.message });
            else refusalModal("Not removed", "", r.message);
            await refreshRom(ctx.appId, true);
          })
        }
      />
    );

  // What is in the mod folders that Forge did not install (The Collector's
  // own Mods button is hidden while Forge's tab is registered, so these are
  // listed here too, with Remove).
  const owned = new Set(records.flatMap((r) => r.entries.map((e) => `${r.target_id}/${e.toLowerCase()}`)));
  const others = targets.flatMap((t) =>
    (t.installed ?? [])
      .map((e) => e.name)
      .filter((n) => n && !owned.has(`${t.target_id}/${n.toLowerCase()}`))
      .slice(0, 20)
      .map((name) => ({ target: t, name }))
  );
  const removeOther = (t: ModTarget, name: string) =>
    showModal(
      <ConfirmModal
        strTitle={`Remove ${name}?`}
        strDescription={`The Collector moves ${name} from ${t.label} to its backup folder. Nothing is deleted.`}
        strOKButtonText="Remove"
        strCancelButtonText="Cancel"
        onOK={() =>
          void run(async () => {
            if (!b?.remove) return;
            const r = await b.remove(ctx.appId, t.target_id, name);
            if (isOk(r)) toaster.toast({ title: "Removed", body: r.backup_folder ? `Backed up to ${r.backup_folder}` : name });
            else {
              const f = failure(r);
              refusalModal("Not removed", f.reason, f.message);
            }
            await refreshRom(ctx.appId);
          })
        }
      />
    );

  const update = (rec: RomModRecord, u: RomUpdate) =>
    void run(async () => {
      const target = targets.find((t) => t.target_id === rec.target_id);
      await installFor(
        ctx,
        {
          source: rec.source,
          file: {
            mod_id: rec.mod_id,
            file_id: u.file.file_id,
            file_name: u.file.file_name,
            name: rec.name,
            version: u.file.version,
            date: u.file.date,
            domain: rec.domain,
          },
          keepEntries: rec.entries,
        },
        u.file.file_name,
        target
      );
    });

  return (
    <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "8px 2px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <span style={{ fontSize: `${CARD_TEXT.title}px`, fontWeight: 700, color: WHITE }}>Mods</span>
        <span style={{ color: FORGE_STEEL }}>{records.length} by Forge</span>
        <UpdatesChip n={summary.updates} />
        <span style={{ flex: "1 1 auto" }} />
        {ctx.platformName && <span style={{ color: STEEL_MUTED, fontSize: `${CARD_TEXT.hint}px` }}>{ctx.platformName}</span>}
      </div>
      {line(summary.status.text, TONE[summary.status.tone])}
      {targets.length > 0 && line(`Mod folders: ${targets.map((t) => t.label).join(", ")}`, STEEL_MUTED)}
      {settingOff?.setting && b?.enableSetting && (
        <Focusable flow-children="row" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {line(`${settingOff.setting.label} is off: mods there won't load.`, AMBER)}
          <DialogButton
            style={{ width: "auto", flex: "0 0 auto" }}
            disabled={busy}
            onClick={() =>
              showModal(
                <ConfirmModal
                  strTitle={`Turn on ${settingOff.setting?.label}?`}
                  strDescription="Close the emulator first. The Collector copies its settings file to the backup folder, then changes that one line."
                  strOKButtonText="Turn on"
                  onOK={() =>
                    void run(async () => {
                      const r = await b.enableSetting!(ctx.appId, settingOff.target_id);
                      if (!isOk(r)) {
                        const f = failure(r);
                        refusalModal("Not turned on", f.reason, f.message);
                      }
                      await refreshRom(ctx.appId);
                    })
                  }
                />
              )
            }
          >
            Turn on
          </DialogButton>
        </Focusable>
      )}
      <Focusable flow-children="row" style={{ display: "flex", gap: "8px" }}>
        <DialogButton disabled={!can || busy} onClick={() => void run(() => fromGameBanana(ctx))} style={{ flex: "1 1 0" }}>
          GameBanana
        </DialogButton>
        <DialogButton disabled={!can || busy} onClick={() => void run(() => fromNexus(ctx))} style={{ flex: "1 1 0" }}>
          Nexus Mods
        </DialogButton>
        <DialogButton disabled={!can || busy} onClick={() => void run(() => fromDownloads(ctx))} style={{ flex: "1 1 0" }}>
          My Downloads
        </DialogButton>
        {b?.openFolder && targets.length > 0 && (
          <DialogButton
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const t = targets.length === 1 ? targets[0] : await choose("Open which folder?", targets.map((x) => ({ label: x.label, value: x })));
                if (t) await b.openFolder!(ctx.appId, t.target_id);
              })
            }
            style={{ flex: "1 1 0" }}
          >
            Open folder
          </DialogButton>
        )}
      </Focusable>
      {records.length === 0 && line(can ? "No mods installed by Forge yet." : "", STEEL_MUTED)}
      {records.map((rec) => {
        const u = st.updates[rec.id];
        return (
          <Focusable key={rec.id} flow-children="row" style={{ display: "flex", gap: "8px", alignItems: "center", minHeight: "40px" }}>
            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
              {line(rec.name, WHITE)}
              {line(
                [sourceName(rec.source), rec.target_label, rec.version && `v${rec.version}`].filter(Boolean).join(" · "),
                STEEL_MUTED
              )}
            </div>
            {u && rec.source !== "local" && (
              <DialogButton disabled={busy} onClick={() => update(rec, u)} style={{ width: "auto", flex: "0 0 auto" }}>
                Update{u.current ? ` to ${u.current}` : ""}
              </DialogButton>
            )}
            <DialogButton disabled={busy || !b?.remove} onClick={() => remove(rec)} style={{ width: "auto", flex: "0 0 auto" }}>
              Remove
            </DialogButton>
          </Focusable>
        );
      })}
      {others.length > 0 && line("Other files in the mod folders", WHITE)}
      {others.map((o) => (
        <Focusable key={`${o.target.target_id}/${o.name}`} flow-children="row" style={{ display: "flex", gap: "8px", alignItems: "center", minHeight: "36px" }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>{line(`${o.name} · ${o.target.label}`, FORGE_STEEL)}</div>
          <DialogButton disabled={busy || !b?.remove} onClick={() => removeOther(o.target, o.name)} style={{ width: "auto", flex: "0 0 auto" }}>
            Remove
          </DialogButton>
        </Focusable>
      ))}
      <div style={{ color: STEEL_MUTED, fontSize: `${CARD_TEXT.hint}px` }}>
        Installs go through The Collector: you see its preview first, and anything replaced or removed is moved to its backup
        folder.
      </div>
    </Focusable>
  );
}

// ---- The Overview card ----------------------------------------------------------------

function RomTabModal({ ctx, closeModal }: { ctx: RomPageContext; closeModal?: () => void }) {
  return (
    <ModalRoot closeModal={closeModal}>
      <RomBoundary>
        <RomModsTab ctx={ctx} />
      </RomBoundary>
    </ModalRoot>
  );
}

function RomModsCard({ ctx }: { ctx: RomPageContext }) {
  const st = useRom(ctx.appId, ctx.romId, true);
  const summary = romCardSummary({
    installed: ctx.installed,
    records: st.records ?? [],
    updates: Object.keys(st.updates).length,
    targets: st.targets,
    bridge: Boolean(bridge()),
  });
  // X opens the Mods tab: The Collector's when it offers a way to switch,
  // else the tab's content in a modal.
  const open = () => {
    if (typeof ctx.openTab === "function") {
      try {
        ctx.openTab(FORGE_EXT_ID);
        return;
      } catch {
        // fall through to the modal
      }
    }
    showModal(<RomTabModal ctx={ctx} />);
  };
  return (
    <DialogButton
      onClick={open}
      onSecondaryButton={open}
      onSecondaryActionDescription={MODS_TAB_TITLE}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: "6px",
        padding: "12px 16px",
        textAlign: "left",
        background: FORGE_GUNMETAL,
        borderRadius: "10px",
        color: FORGE_STEEL,
        border: "none",
        boxShadow: "none",
        outlineColor: FORGE_CRIMSON,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
        <span style={{ fontSize: `${CARD_TEXT.title}px`, fontWeight: 700, color: WHITE }}>Mods</span>
        <span style={{ color: FORGE_STEEL }}>{summary.active ? `${summary.active} active` : "No mods"}</span>
        <UpdatesChip n={summary.updates} />
        <span style={{ flex: "1 1 auto" }} />
        <Prompt button="X" label={MODS_TAB_TITLE} />
      </span>
      <span style={{ color: TONE[summary.status.tone], whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {summary.status.text}
      </span>
    </DialogButton>
  );
}

// ---- Registration ------------------------------------------------------------------

/** The two extensions Forge registers on The Collector's game page: the tab
 * (exactly "forge.mods": The Collector then hides its own Mods button) and
 * the Overview card ("forge.mods.card"; ids are unique across kinds). Each
 * renders inside its own error boundary (and The Collector adds one). */
export function romExtensions(): GamePageExtension[] {
  return [
    {
      id: FORGE_EXT_ID,
      kind: "tab",
      label: MODS_TAB_TITLE,
      order: 50,
      isAvailable: () => true,
      render: (ctx: RomPageContext) => (
        <RomBoundary key={`forge-rom-tab-${ctx.appId}-${ctx.romId}`}>
          <RomModsTab ctx={ctx} />
        </RomBoundary>
      ),
    },
    {
      id: FORGE_CARD_ID,
      kind: "overviewCard",
      label: MODS_TAB_TITLE,
      order: 50,
      isAvailable: () => true,
      render: (ctx: RomPageContext) => (
        <RomBoundary key={`forge-rom-card-${ctx.appId}-${ctx.romId}`}>
          <RomModsCard ctx={ctx} />
        </RomBoundary>
      ),
    },
  ];
}
