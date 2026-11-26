// Forge's Mods section on Steam's own game page (/library/app/:appid):
// the game's installed mods with their switches and updates, Add mods, the
// anti-cheat lock, and the offer to go back after a crash.
//
// Injected by gamePagePatch.tsx inside an error boundary. Nothing here
// takes focus on its own: Play keeps the page's first focus, and the
// section is reached by pressing up from it.
import {
  ConfirmModal,
  DialogButton,
  Focusable,
  Navigation,
  QuickAccessTab,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useRef, useState } from "react";

import {
  ForgeGuardSummary,
  InstalledMod,
  forgeGameStatus,
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
  lockBody,
  lockHeadline,
  modSet,
  offerBody,
  overrideLabel,
  rowsToShow,
  sectionMode,
  undoOutcome,
} from "./forgeRules";
import { getForgeSetting, subscribeForgeSettings } from "./forgeSettings";
import { allowModsAnyway, lockModsAgain, overrideOnLabel } from "./ForgeLock";
import { SupportedGame, getSupportedGame, isExperimentalEnabled, modeParams } from "./games";
import { toggleMod } from "./install";
import { notifyGameStateChanged, setBrowseGame, setDetailOrigin, setSelectedMod, subscribeGameState } from "./state";
import { pushFromGamePage } from "./Tabs";

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
  background: #262a30 !important;
  color: #ffffff !important;
}
.${BTN}.forge-primary { background: ${FORGE_CRIMSON} !important; color: #fff !important; }
.${BTN}.forge-primary.gpfocus, .${BTN}.forge-primary:hover { border-color: #ffffff !important; }
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
        color: crimson ? "#fff" : FORGE_STEEL,
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
  const seq = useRef(0);

  const refresh = (refreshUpdates = false) => {
    const mine = ++seq.current;
    const current = () => mine === seq.current;
    forgeGameStatus(appId, game?.nexusDomain ?? "", game?.installDirName ?? "")
      .then((r) => current() && r.ok && setStatus({ anticheat: r.anticheat, guard: r.guard }))
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
    return () => {
      seq.current++;
      unsubState();
      unsubSettings();
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

  const shown = expanded ? list : rowsToShow(list, updates);
  const locked = mode === "locked";

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
        <div style={{ fontSize: "16px", fontWeight: 700, color: "#fff", letterSpacing: "0.04em" }}>MODS</div>
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
          <div style={{ color: "#fff", fontWeight: 700 }}>Restore last working mods?</div>
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
                  <span style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#fff" }}>
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
