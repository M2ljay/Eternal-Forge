// Forge's Mods section on Steam's own game page (/library/app/:appid):
// the game's installed mods with their switches and updates, Add mods, the
// anti-cheat lock, and the offer to go back after a crash.
//
// Injected by gamePagePatch.tsx inside an error boundary. Nothing here
// takes focus on its own: Play keeps the page's first focus, and the
// section is reached by pressing up from it.
import {
  ButtonItem,
  ConfirmModal,
  DialogButton,
  Focusable,
  ModalRoot,
  Navigation,
  QuickAccessTab,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useRef, useState } from "react";

import {
  ForgeGuardSummary,
  ForgeLoadOrderState,
  InstalledMod,
  OptiScalerResult,
  OptiScalerStatus,
  SaveBackupStatus,
  forgeGameStatus,
  forgeLoSort,
  forgeLoStatus,
  forgeOptiScalerDismiss,
  forgeOptiScalerInstall,
  forgeOptiScalerRemove,
  forgeOptiScalerSetUpscaler,
  forgeOptiScalerStatus,
  forgeSaveBackupStatus,
  forgeGuardDismiss,
  forgeGuardPlan,
  forgeGuardRestored,
  forgeGuardUndone,
  forgeUpdateDots,
  getInstalledMods,
  getModDetails,
  setAllModsEnabled,
} from "./api";
import {
  AntiCheatVerdict,
  FORGE_BLACK,
  FORGE_CRIMSON,
  FORGE_GUNMETAL,
  FORGE_STEEL,
  RestorePlan,
  countLabel,
  loadOrderSupported,
  masterlistLine,
  sortOutcome,
  warningSummary,
  lockBody,
  lockHeadline,
  modSet,
  offerBody,
  optiscalerLine,
  overrideLabel,
  rowsToShow,
  saveBackupLine,
  sectionMode,
  undoOutcome,
} from "./forgeRules";
import { getForgeSetting, subscribeForgeSettings } from "./forgeSettings";
import { allowModsAnyway, lockModsAgain, overrideOnLabel } from "./ForgeLock";
import { SupportedGame, getSupportedGame, isExperimentalEnabled, modeParams } from "./games";
import { toggleMod } from "./install";
import { notifyGameStateChanged, setBrowseGame, setDetailOrigin, setSelectedMod, subscribeGameState } from "./state";
import { pushFromGamePage } from "./Tabs";
import { backupBeforeChange, openRestoreSaves, subscribeSaveBackups } from "./SaveBackup";
import { AMBER, CRIMSON_TEXT, GREEN, GUNMETAL_RAISED, STEEL_MUTED, WHITE } from "./palette";
import { noteOptiScaler, subscribeOptiScaler } from "./optiscaler";
import { openForgeLoadOrder, openProfiles } from "./ForgeLoadOrder";
import { ForgeLoScope } from "./forgeLoScope";
import { isGameRunning } from "./steam";

// Our own routes (registered in index.tsx).
const BROWSE_ROUTE = "/nexus-mods";
const DETAIL_ROUTE = "/nexus-mods/mod";
const MANAGER_ROUTE = "/nexus-mods/manager";

const BTN = "forge-btn";
const ROW = "forge-row";
// Focus is a crimson edge and a lighter surface, never a glow.
const CSS = `
.${BTN}, .${ROW} {
  background: ${FORGE_GUNMETAL} !important;
  color: ${FORGE_STEEL} !important;
  border: 2px solid transparent !important;
  border-radius: 6px !important;
  box-shadow: none !important;
  min-width: 0 !important;
}
.${BTN} { padding: 6px 14px !important; font-size: 13px !important; white-space: nowrap; }
.${BTN}.gpfocus, .${BTN}.gpfocuswithin, .${BTN}:hover,
.${ROW}.gpfocus, .${ROW}.gpfocuswithin, .${ROW}:hover {
  border-color: ${FORGE_CRIMSON} !important;
  background: ${GUNMETAL_RAISED} !important;
  color: ${WHITE} !important;
}
.${BTN}.forge-primary { background: ${FORGE_CRIMSON} !important; color: ${WHITE} !important; }
.${BTN}.forge-primary.gpfocus, .${BTN}.forge-primary:hover { border-color: ${WHITE} !important; }
`;

interface Status {
  anticheat: AntiCheatVerdict;
  guard: ForgeGuardSummary;
}

function Chip({ children, crimson }: { children: React.ReactNode; crimson?: boolean }) {
  return (
    <span
      style={{
        fontSize: "12px",
        padding: "2px 8px",
        borderRadius: "10px",
        background: crimson ? FORGE_CRIMSON : FORGE_GUNMETAL,
        color: crimson ? WHITE : FORGE_STEEL,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Button({
  onClick,
  children,
  primary,
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <DialogButton
      className={`${BTN}${primary ? " forge-primary" : ""}`}
      disabled={disabled}
      onClick={onClick}
      style={{ width: "auto", flex: "0 0 auto" }}
    >
      {children}
    </DialogButton>
  );
}

async function applyChanges(
  game: SupportedGame,
  changes: { folder: string; enabled: boolean }[]
): Promise<string[]> {
  const failed: string[] = [];
  // One at a time, through install.ts like every other switch: some games
  // recompile their whole enabled set per change.
  for (const c of changes) {
    const r = await toggleMod(game, c.folder, c.enabled, c.enabled ? undefined : "Restored last working mods");
    if (!r.ok) failed.push(`${c.folder}: ${r.error ?? "failed"}`);
  }
  return failed;
}

export function GameModsSection({ appId }: { appId: number }) {
  const game = getSupportedGame(appId);
  const [status, setStatus] = useState<Status | undefined>();
  const [mods, setMods] = useState<InstalledMod[] | undefined>();
  const [updates, setUpdates] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enabledSetting, setEnabledSetting] = useState(() => getForgeSetting("gamePage"));
  const [saves, setSaves] = useState<SaveBackupStatus | undefined>();
  const seq = useRef(0);

  const refresh = (refreshUpdates = false) => {
    const mine = ++seq.current;
    const current = () => mine === seq.current;
    forgeGameStatus(appId, game?.nexusDomain ?? "", game?.installDirName ?? "")
      .then((r) => current() && r.ok && setStatus({ anticheat: r.anticheat, guard: r.guard }))
      .catch(() => undefined);
    forgeSaveBackupStatus(appId)
      .then((r) => current() && r.ok && setSaves(r))
      .catch(() => undefined);
    if (!game) return;
    getInstalledMods(
      game.nexusDomain,
      game.installDirName,
      game.modsSubdir,
      ...modeParams(game),
      game.protectedModFolders ?? []
    )
      .then((r) => current() && setMods(r.ok ? r.mods ?? [] : []))
      .catch(() => current() && setMods([]));
    forgeUpdateDots([game.nexusDomain], refreshUpdates)
      .then((r) => current() && setUpdates(new Set(r.games?.[game.nexusDomain]?.folders ?? [])))
      .catch(() => undefined);
  };

  useEffect(() => {
    refresh(true);
    const unsubState = subscribeGameState(() => refresh(false));
    const unsubSettings = subscribeForgeSettings(() => setEnabledSetting(getForgeSetting("gamePage")));
    const unsubSaves = subscribeSaveBackups((id) => {
      if (id === appId) forgeSaveBackupStatus(appId).then((r) => r.ok && setSaves(r)).catch(() => undefined);
    });
    return () => {
      seq.current++;
      unsubState();
      unsubSettings();
      unsubSaves();
    };
  }, [appId]);

  const mode = sectionMode({
    managed: Boolean(game),
    locked: Boolean(status?.anticheat.locked),
    experimental: isExperimentalEnabled(),
    enabledSetting,
  });
  if (mode === "hidden" || !status) return null;

  const ac = status.anticheat;
  const guard = status.guard;
  const list = mods ?? [];
  const enabledCount = list.filter((m) => m.enabled).length;

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toaster.toast({ title: "Forge", body: String(e) });
    } finally {
      setBusy(false);
      notifyGameStateChanged();
      refresh(false);
    }
  };

  const openStore = () => {
    if (!game) return;
    setBrowseGame(game);
    pushFromGamePage(BROWSE_ROUTE);
  };
  const openManager = () => {
    if (!game) return;
    setBrowseGame(game);
    pushFromGamePage(MANAGER_ROUTE);
  };
  const openMod = (mod: InstalledMod) =>
    void run(async () => {
      if (!game || !mod.mod_id) return;
      const r = await getModDetails(game.nexusDomain, mod.mod_id);
      if (!r.ok || !r.mod) {
        toaster.toast({ title: "Could not open mod", body: r.error ?? mod.name ?? mod.folder });
        return;
      }
      setSelectedMod({ game, mod: r.mod });
      setDetailOrigin("browse");
      pushFromGamePage(DETAIL_ROUTE);
    });

  const toggle = (mod: InstalledMod) =>
    void run(async () => {
      if (!game) return;
      const r = await toggleMod(game, mod.folder, !mod.enabled);
      if (!r.ok) toaster.toast({ title: "Could not switch mod", body: r.error ?? "" });
    });

  const allOff = () =>
    void run(async () => {
      if (!game) return;
      const r = await setAllModsEnabled(
        game.installDirName,
        game.modsSubdir,
        false,
        game.installMode ?? "folder",
        game.nexusDomain,
        game.appId,
        game.pluginsTxtSubpath ?? "",
        game.pluginsTxtStyle ?? "starred"
      );
      if (!r.ok) toaster.toast({ title: "Could not switch mods off", body: r.error ?? "" });
    });

  const offerRestore = () =>
    void run(async () => {
      if (!game) return;
      const current = modSet(list);
      const plan = (await forgeGuardPlan(appId, current, "restore")) as RestorePlan & { ok: boolean };
      const names = Object.fromEntries(list.map((m) => [m.folder, m.name ?? m.folder]));
      showModal(
        <ConfirmModal
          strTitle="Restore last working mods?"
          strDescription={offerBody(plan, names)}
          strOKButtonText="Restore"
          strCancelButtonText="Not now"
          onOK={() =>
            void run(async () => {
              await backupBeforeChange(appId, game.displayName, "crash restore");
              const failed = await applyChanges(game, plan.changes);
              await forgeGuardRestored(appId, current);
              toaster.toast({
                title: failed.length ? "Restored, with problems" : "Last working mods restored",
                body: failed.length ? failed.slice(0, 3).join("; ") : "Undo is on the game page.",
              });
            })
          }
        />
      );
    });

  const undoRestore = () =>
    void run(async () => {
      if (!game) return;
      const plan = await forgeGuardPlan(appId, modSet(list), "undo");
      await backupBeforeChange(appId, game.displayName, "undo restore");
      const failed = await applyChanges(game, plan.changes);
      // Keep the record unless everything went back: a refused change
      // (locked game, busy folder) must leave Undo available to retry.
      const outcome = undoOutcome(failed);
      if (outcome.clearRecord) await forgeGuardUndone(appId);
      toaster.toast({ title: outcome.title, body: outcome.body });
    });

  // One press: the label carries the risk (see ForgeLock.tsx).
  const allowAnyway = () =>
    void run(async () => {
      await allowModsAnyway(appId);
    });

  const relock = () =>
    void run(async () => {
      await lockModsAgain(appId);
    });

  const restoreSaves = () =>
    void run(async () => {
      await openRestoreSaves(appId, game?.displayName ?? "this game", () => refresh(false));
    });

  const shown = expanded ? list : rowsToShow(list, updates);
  const locked = mode === "locked";
  // Saves: only with Ludusavi installed, and for locked games too (a
  // backup only reads the game).
  const saveLine = mode === "mods" || locked ? saveBackupLine(Boolean(saves?.found), saves?.game, Date.now() / 1000) : null;

  return (
    <Focusable
      flow-children="column"
      style={{
        margin: "12px 2.8vw 4px",
        padding: "12px 16px",
        background: FORGE_BLACK,
        border: `1px solid ${FORGE_GUNMETAL}`,
        borderRadius: "8px",
        color: FORGE_STEEL,
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      <style>{CSS}</style>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <div style={{ width: "4px", height: "18px", background: FORGE_CRIMSON, borderRadius: "2px" }} />
        <div style={{ fontSize: "16px", fontWeight: 700, color: WHITE, letterSpacing: "0.04em" }}>MODS</div>
        {mode === "mods" && <Chip>{mods ? countLabel(list) : "Reading..."}</Chip>}
        {mode === "mods" && updates.size > 0 && (
          <Chip crimson>
            {updates.size} update{updates.size === 1 ? "" : "s"}
          </Chip>
        )}
        {ac.detected && ac.override_on && <Chip crimson>{overrideOnLabel(ac)}</Chip>}
      </div>

      {locked && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ color: FORGE_CRIMSON, fontWeight: 700 }}>{lockHeadline(ac)}</div>
          <div style={{ fontSize: "13px", lineHeight: 1.45 }}>{lockBody(ac)}</div>
        </div>
      )}

      {guard.offer && game && !locked && (
        <div
          style={{
            border: `2px solid ${FORGE_CRIMSON}`,
            borderRadius: "6px",
            padding: "10px 12px",
            background: FORGE_GUNMETAL,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div style={{ color: WHITE, fontWeight: 700 }}>Restore last working mods?</div>
          <div style={{ fontSize: "13px" }}>
            {game.displayName} closed early twice since its mods changed. Going back only switches mods
            on and off; nothing is deleted.
          </div>
          <Focusable flow-children="row" style={{ display: "flex", gap: "8px" }}>
            <Button primary disabled={busy} onClick={offerRestore}>
              Restore...
            </Button>
            <Button disabled={busy} onClick={() => void run(async () => void (await forgeGuardDismiss(appId)))}>
              Not now
            </Button>
          </Focusable>
        </div>
      )}

      {mode === "mods" && list.length > 0 && (
        <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {shown.map((m) => {
            const hasUpdate = updates.has(m.folder);
            const canSwitch = m.togglable !== false;
            return (
              <Focusable key={m.folder} flow-children="row" style={{ display: "flex", gap: "8px" }}>
                <DialogButton
                  className={ROW}
                  disabled={busy || !canSwitch}
                  onClick={() => toggle(m)}
                  style={{ flex: "1 1 auto", display: "flex", alignItems: "center", gap: "10px", padding: "6px 12px", textAlign: "left" }}
                >
                  <span
                    style={{
                      width: "10px",
                      height: "10px",
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: m.enabled ? FORGE_CRIMSON : "transparent",
                      border: `2px solid ${m.enabled ? FORGE_CRIMSON : FORGE_STEEL}`,
                    }}
                  />
                  <span style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: WHITE }}>
                    {m.name ?? m.folder}
                  </span>
                  {m.version && <span style={{ fontSize: "12px", opacity: 0.8 }}>{m.version}</span>}
                  {hasUpdate && <Chip crimson>Update</Chip>}
                  <span style={{ fontSize: "12px", minWidth: "28px", textAlign: "right" }}>
                    {m.togglable === false ? "always on" : m.enabled ? "On" : "Off"}
                  </span>
                </DialogButton>
                {m.mod_id ? (
                  <Button disabled={busy} onClick={() => openMod(m)}>
                    {hasUpdate ? "Update" : "Open"}
                  </Button>
                ) : null}
              </Focusable>
            );
          })}
        </Focusable>
      )}

      {saveLine && (
        <div style={{ display: "flex", gap: "10px", alignItems: "baseline", flexWrap: "wrap", fontSize: "12px" }}>
          <span style={{ color: STEEL_MUTED }}>{saveLine.text}</span>
          {saveLine.failed && <span style={{ color: AMBER }}>{saveLine.failed}</span>}
        </div>
      )}

      <UpscalingEntry appId={appId} game={game} />

      <LoadOrderEntry appId={appId} game={game} locked={locked} />

      {mode === "setup" && !locked && (
        <div style={{ fontSize: "13px" }}>
          Mods are not set up for this game yet. Open the Quick Access Menu, Forge, to set it up.
        </div>
      )}

      <Focusable flow-children="row" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {mode === "mods" && !locked && (
          <Button primary disabled={busy} onClick={openStore}>
            Add mods
          </Button>
        )}
        {mode === "mods" && list.length > shown.length && (
          <Button onClick={() => setExpanded(true)}>Show all {list.length}</Button>
        )}
        {mode === "mods" && expanded && list.length > rowsToShow(list, updates).length && (
          <Button onClick={() => setExpanded(false)}>Show fewer</Button>
        )}
        {mode === "mods" && list.length > 0 && <Button onClick={openManager}>My Mods</Button>}
        {saveLine && (
          <Button disabled={busy} onClick={restoreSaves}>
            Restore saves...
          </Button>
        )}
        {guard.undo && game && (
          <Button disabled={busy} onClick={undoRestore}>
            Undo restore
          </Button>
        )}
        {locked && game && enabledCount > 0 && (
          <Button primary disabled={busy} onClick={allOff}>
            Switch {enabledCount} mod{enabledCount === 1 ? "" : "s"} off
          </Button>
        )}
        {locked && ac.override_allowed && (
          <Button disabled={busy} onClick={allowAnyway}>
            {overrideLabel(ac)}
          </Button>
        )}
        {ac.detected && ac.override_on && (
          <Button disabled={busy} onClick={relock}>
            Lock mods again
          </Button>
        )}
        {mode === "setup" && !locked && (
          <Button onClick={() => Navigation.OpenQuickAccessMenu(QuickAccessTab.Decky)}>Set up mods</Button>
        )}
      </Focusable>
    </Focusable>
  );
}

// ---- Upscaling (OptiScaler) ---------------------------------------------------
// One entry in the section, for any game the section shows. Install, update,
// switch upscaler, try another proxy name, remove. Refused games show the
// crimson line and nothing else: there is no override for DLL injection.

function UpscalerModal({
  title,
  status,
  current,
  onPick,
  closeModal,
}: {
  title: string;
  status: OptiScalerStatus;
  current?: string;
  onPick: (u: string) => void;
  closeModal?: () => void;
}) {
  const gpu = status.gpu.names.length ? status.gpu.names.join(", ") : "not detected";
  return (
    <ModalRoot closeModal={closeModal}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <div style={{ fontSize: "13px", marginBottom: "8px", color: STEEL_MUTED }}>
        Graphics card: {gpu}. OptiScaler ({status.license}) is downloaded from its official GitHub release.
        The game must already offer DLSS, FSR 2/3 or XeSS for OptiScaler to swap it. Forge backs your saves up
        first when Ludusavi is installed.
      </div>
      {status.upscalers.choices.map((u) => (
        <ButtonItem
          key={u}
          layout="below"
          description={u === status.upscalers.default ? "Recommended for this PC" : undefined}
          onClick={() => {
            closeModal?.();
            onPick(u);
          }}
        >
          {status.upscalers.labels[u] ?? u}
          {u === current ? " (current)" : ""}
        </ButtonItem>
      ))}
    </ModalRoot>
  );
}

const NEXT_PROXY: Record<string, string> = { "dxgi.dll": "winmm.dll", "winmm.dll": "version.dll", "version.dll": "dxgi.dll" };

function UpscalingEntry({ appId, game }: { appId: number; game?: SupportedGame }) {
  const [st, setSt] = useState<OptiScalerStatus | undefined>();
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const domain = game?.nexusDomain ?? "";
  const installDir = game?.installDirName ?? "";

  const load = (check: boolean) => {
    const mine = ++seq.current;
    forgeOptiScalerStatus(appId, domain, installDir, check)
      .then((r) => {
        if (mine !== seq.current || !r?.ok) return;
        setSt(r);
        noteOptiScaler(appId, r.installed.installed);
        // Installed: one look for a newer release, then local only.
        if (!check && r.installed.installed && r.allowed) load(true);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    load(false);
    const unsub = subscribeOptiScaler((id) => id === appId && load(false));
    return () => {
      seq.current++;
      unsub();
    };
  }, [appId]);

  if (!st) return null;
  const line = optiscalerLine(st);
  const inst = st.installed;

  const act = async (fn: () => Promise<OptiScalerResult>, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      if (r.hash_changed) {
        showModal(
          <ConfirmModal
            strTitle="OptiScaler download changed"
            strDescription={`${r.error ?? ""} Forge pinned the first copy it installed; this one differs.`}
            strOKButtonText="Install anyway"
            strCancelButtonText="Cancel"
            onOK={() => void act(() => install(inst.upscaler || st.upscalers.default, "", true), done)}
          />
        );
      } else if (!r.ok) {
        toaster.toast({ title: r.not_allowed ? r.error ?? "Not allowed" : "OptiScaler", body: r.detail ?? r.error ?? "" });
      } else {
        const saveNote = r.save_backup?.ran && !r.save_backup.ok ? " Save backup failed; the install went ahead." : "";
        toaster.toast({ title: "OptiScaler", body: done + saveNote });
      }
    } catch (e) {
      toaster.toast({ title: "OptiScaler", body: String(e) });
    } finally {
      setBusy(false);
      load(false);
    }
  };

  const install = (upscaler: string, proxy = "", accept = false) =>
    forgeOptiScalerInstall(appId, upscaler, domain, installDir, game?.processName ?? "", proxy, accept);

  const pickAndInstall = () =>
    showModal(
      <UpscalerModal
        title="Install OptiScaler"
        status={st}
        onPick={(u) => void act(() => install(u), "Installed. Pick the game's DLSS / FSR / XeSS option in its settings.")}
      />
    );
  const pickUpscaler = () =>
    showModal(
      <UpscalerModal
        title="Upscaler"
        status={st}
        current={inst.upscaler || ""}
        onPick={(u) => void act(() => forgeOptiScalerSetUpscaler(appId, u), "Upscaler changed.")}
      />
    );
  const remove = () => void act(() => forgeOptiScalerRemove(appId), "Removed; the game's own files are back.");
  const update = () => void act(() => install(inst.upscaler || st.upscalers.default), "Updated.");
  const otherName = () =>
    void act(
      () => install(inst.upscaler || st.upscalers.default, NEXT_PROXY[inst.proxy ?? ""] ?? "dxgi.dll"),
      "Reinstalled under another name."
    );
  const keep = () => void act(async () => ({ ...(await forgeOptiScalerDismiss(appId)) }), "Kept.");

  const color = line.tone === "refused" || line.tone === "suspect" ? CRIMSON_TEXT : line.tone === "installed" ? GREEN : STEEL_MUTED;
  return (
    <Focusable
      flow-children="column"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "8px 12px",
        background: FORGE_GUNMETAL,
        borderRadius: "6px",
        border: line.tone === "suspect" ? `2px solid ${FORGE_CRIMSON}` : "2px solid transparent",
      }}
    >
      <div style={{ display: "flex", gap: "10px", alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ color: WHITE, fontWeight: 700, fontSize: "13px" }}>Upscaling (OptiScaler)</span>
        <span style={{ color, fontSize: "12px", fontWeight: line.tone === "refused" ? 700 : 400 }}>{line.text}</span>
      </div>
      {line.tone === "refused" && st.refusal?.detail && (
        <div style={{ fontSize: "12px", color: STEEL_MUTED }}>{st.refusal.detail}</div>
      )}
      {line.tone === "suspect" && (
        <div style={{ fontSize: "12px" }}>Removing it puts the game's own files back. Nothing else changes.</div>
      )}
      <Focusable flow-children="row" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {line.tone === "suspect" && (
          <Button primary disabled={busy} onClick={remove}>
            Remove OptiScaler
          </Button>
        )}
        {line.tone === "suspect" && (
          <Button disabled={busy} onClick={keep}>
            Keep it
          </Button>
        )}
        {line.tone === "off" && (
          <Button disabled={busy} onClick={pickAndInstall}>
            Install...
          </Button>
        )}
        {line.tone === "installed" && st.update_available && (
          <Button primary disabled={busy} onClick={update}>
            Update to {st.latest}
          </Button>
        )}
        {line.tone === "installed" && (
          <Button disabled={busy} onClick={pickUpscaler}>
            Upscaler...
          </Button>
        )}
        {line.tone === "installed" && (
          <Button disabled={busy} onClick={otherName}>
            Use {NEXT_PROXY[inst.proxy ?? ""] ?? "dxgi.dll"} instead
          </Button>
        )}
        {inst.installed && line.tone !== "suspect" && (
          <Button disabled={busy} onClick={remove}>
            Remove
          </Button>
        )}
      </Focusable>
    </Focusable>
  );
}

// ---- Load order (LOOT rules) and profiles -------------------------------------
// Skyrim SE, Fallout 4, Starfield and Oblivion Remastered only. One line with
// the counts, problems and the current profile; the plugin list itself is the
// Load order panel (a page, opened from here; B comes back). Sorting and
// profile switches are refused by the backend while the game runs, and on a
// locked game the writers are not offered.

function steamName(appId: number, fallback: string): string {
  try {
    return (globalThis as any).appStore?.GetAppOverviewByAppID?.(appId)?.display_name || fallback;
  } catch {
    return fallback;
  }
}

function LoadOrderEntry({ appId, game, locked }: { appId: number; game?: SupportedGame; locked: boolean }) {
  const [st, setSt] = useState<ForgeLoadOrderState | undefined>();
  const [busy, setBusy] = useState(false);
  const supported = loadOrderSupported(appId, game?.nexusDomain);
  const scope: ForgeLoScope = {
    appId,
    domain: game?.nexusDomain ?? "",
    installDir: game?.installDirName ?? "",
    name: game?.displayName ?? steamName(appId, "this game"),
    game,
  };
  const refresh = () => {
    if (!supported) return;
    forgeLoStatus(appId, scope.domain, scope.installDir)
      .then((r) => setSt(r))
      .catch(() => undefined);
  };
  useEffect(() => {
    refresh();
    return subscribeGameState(() => refresh());
  }, [appId]);
  if (!supported || !st?.supported) return null;

  const sum = warningSummary(st.counts);
  const sort = async () => {
    if (busy) return;
    if (isGameRunning(appId)) {
      toaster.toast({ title: "Close the game first", body: "Its load order can't change while it runs." });
      return;
    }
    setBusy(true);
    try {
      toaster.toast(sortOutcome(await forgeLoSort(appId, scope.domain, scope.installDir)));
    } catch (e) {
      toaster.toast({ title: "Could not sort", body: String(e) });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return (
    <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ display: "flex", gap: "10px", alignItems: "baseline", flexWrap: "wrap", fontSize: "13px" }}>
        <span style={{ color: WHITE, fontWeight: 600 }}>Load order</span>
        <span style={{ color: STEEL_MUTED }}>
          {st.counts?.active ?? 0} of {st.counts?.plugins ?? 0} plugins on
        </span>
        {st.current_profile && <Chip>Profile: {st.current_profile}</Chip>}
        <span style={{ color: sum.tone === "error" ? CRIMSON_TEXT : sum.tone === "warn" ? AMBER : GREEN }}>
          {sum.text}
        </span>
      </div>
      <div style={{ fontSize: "12px", color: STEEL_MUTED }}>{masterlistLine(st.masterlist, Date.now() / 1000)}</div>
      <Focusable flow-children="row" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <Button onClick={() => openForgeLoadOrder(scope)}>Load order</Button>
        {!locked && (
          <Button disabled={busy} onClick={() => void sort()}>
            Sort with LOOT rules
          </Button>
        )}
        {!locked && (
          <Button disabled={busy} onClick={() => openProfiles(scope, st, refresh)}>
            {st.current_profile ? `Profiles (${st.current_profile})` : "Profiles"}
          </Button>
        )}
      </Focusable>
    </Focusable>
  );
}
