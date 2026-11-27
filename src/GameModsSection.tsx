// Forge's Mods section on Steam's own game page (/library/app/:appid).
//
// Collapsed it is one row under the Play bar: "Mods", a status chip or two,
// the last save backup as a hint, and at most two buttons. A on the row
// opens the details under it (the anti-cheat lock, the offer to go back
// after a crash, the mods with their switches, saves, Upscaling and Load
// order), each one line; long explanations sit behind "Why?" in a small
// modal. The anti-cheat override is only in the lock's "Why?" modal.
//
// Injected by gamePagePatch.tsx inside an error boundary, twice: under Play
// ("below") and as a one-line fallback above the overview panel ("above"),
// which renders nothing while the copy under Play is mounted. Nothing here
// takes focus on its own: Play keeps the page's first focus, and the row is
// one press down from it.
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
import { ReactNode, useEffect, useRef, useState } from "react";
import { FaChevronDown, FaChevronUp } from "react-icons/fa";

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
  CARD_ACTION_LABELS,
  CARD_TEXT,
  CardAction,
  CardChip,
  CardInput,
  CardPlacement,
  FORGE_CRIMSON,
  FORGE_GUNMETAL,
  FORGE_STEEL,
  ROW_HEIGHT,
  RestorePlan,
  compactButtons,
  countLabel,
  detailLines,
  loadOrderSupported,
  lockBody,
  lockHeadline,
  lockLineActions,
  lockModalActions,
  lockSummary,
  modSet,
  offerBody,
  optiscalerLine,
  overrideLabel,
  rowPress,
  rowsToShow,
  saveBackupLine,
  savesHint,
  sectionMode,
  sortOutcome,
  statusChips,
  undoOutcome,
  warningSummary,
} from "./forgeRules";
import { ABOVE_GRACE_MS, aboveFallbackShown, placements } from "./gamePageAnchor";
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

const CARD = "forge-card";
const MAIN = "forge-row-main";
const BTN = "forge-btn";
const ROW = "forge-row";
const TEXT = "forge-text";
// Focus is a crimson edge and a lighter surface, never a glow. Text never
// wraps: one line, cut with an ellipsis.
const CSS = `
.${CARD} {
  margin: 8px 2.8vw 4px;
  background: ${FORGE_GUNMETAL};
  border-left: 3px solid ${FORGE_CRIMSON};
  border-radius: 6px;
  color: ${FORGE_STEEL};
  font-size: ${CARD_TEXT.body}px;
  line-height: 1.3;
}
.${TEXT} { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.${BTN}, .${ROW}, .${MAIN} {
  color: ${FORGE_STEEL} !important;
  border: 2px solid transparent !important;
  border-radius: 6px !important;
  box-shadow: none !important;
  min-width: 0 !important;
}
.${BTN}, .${ROW} { background: ${GUNMETAL_RAISED} !important; }
.${MAIN} { background: transparent !important; }
.${BTN} {
  height: 36px !important;
  padding: 0 14px !important;
  font-size: ${CARD_TEXT.button}px !important;
  line-height: 1 !important;
  white-space: nowrap;
}
.${BTN}.gpfocus, .${BTN}.gpfocuswithin, .${BTN}:hover,
.${ROW}.gpfocus, .${ROW}.gpfocuswithin, .${ROW}:hover,
.${MAIN}.gpfocus, .${MAIN}.gpfocuswithin, .${MAIN}:hover {
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

const TONE_COLOR: Record<CardChip["tone"], string> = {
  crimson: CRIMSON_TEXT,
  steel: FORGE_STEEL,
  amber: AMBER,
  hint: STEEL_MUTED,
};

function Chip({ chip }: { chip: CardChip }) {
  return (
    <span
      className={TEXT}
      style={{
        fontSize: `${CARD_TEXT.hint}px`,
        fontWeight: chip.tone === "crimson" ? 700 : 600,
        padding: "3px 10px",
        borderRadius: "12px",
        background: GUNMETAL_RAISED,
        color: TONE_COLOR[chip.tone],
        flex: "0 1 auto",
      }}
    >
      {chip.text}
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
  children: ReactNode;
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

/** One line of the details: a label, a one-line text, then its buttons. */
function Line({
  label,
  text,
  color,
  children,
}: {
  label: string;
  text?: ReactNode;
  color?: string;
  children?: ReactNode;
}) {
  return (
    <Focusable flow-children="row" style={{ display: "flex", alignItems: "center", gap: "8px", minHeight: "40px" }}>
      <span style={{ color: WHITE, fontWeight: 600, flex: "0 0 auto", minWidth: "96px" }}>{label}</span>
      <span className={TEXT} style={{ color: color ?? FORGE_STEEL, flex: "1 1 auto" }}>
        {text}
      </span>
      {children}
    </Focusable>
  );
}

/** A small modal for what does not fit on one line. */
function WhyModal({
  title,
  body,
  children,
  closeModal,
}: {
  title: string;
  body: ReactNode;
  children?: ReactNode;
  closeModal?: () => void;
}) {
  return (
    <ModalRoot closeModal={closeModal}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <div style={{ fontSize: `${CARD_TEXT.body}px`, lineHeight: 1.45, marginBottom: "12px" }}>{body}</div>
      {children}
      <ButtonItem layout="below" onClick={() => closeModal?.()}>
        Close
      </ButtonItem>
    </ModalRoot>
  );
}

export function showWhy(title: string, body: ReactNode): void {
  showModal(<WhyModal title={title} body={body} />);
}

/** The lock's explanation, and the ONLY place the override is offered. One
 * press here, its risk on the button (see ForgeLock.tsx); the backend still
 * reads the stored flag on every install and switch. */
function LockWhyModal({
  appId,
  ac,
  onChanged,
  closeModal,
}: {
  appId: number;
  ac: AntiCheatVerdict;
  onChanged: () => void;
  closeModal?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const press = async (fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      closeModal?.();
      notifyGameStateChanged();
      onChanged();
    }
  };
  const body = (
    <>
      <div>{lockBody(ac)}</div>
      {ac.offline_note && <div style={{ marginTop: "8px", color: STEEL_MUTED }}>{ac.offline_note}</div>}
    </>
  );
  return (
    <WhyModal title={ac.override_on ? overrideOnLabel(ac) : lockHeadline(ac)} body={body} closeModal={closeModal}>
      {lockModalActions(ac).map((a) =>
        a === "allow-anyway" ? (
          <ButtonItem key={a} layout="below" disabled={busy} onClick={() => void press(() => allowModsAnyway(appId))}>
            {overrideLabel(ac)}
          </ButtonItem>
        ) : (
          <ButtonItem key={a} layout="below" disabled={busy} onClick={() => void press(() => lockModsAgain(appId))}>
            Lock mods again
          </ButtonItem>
        )
      )}
    </WhyModal>
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

export function GameModsSection({ appId, placement }: { appId: number; placement: CardPlacement }) {
  return placement === "below" ? <BelowPlay appId={appId} /> : <AbovePlay appId={appId} />;
}

/** Under Play: registers itself so the line above stays empty. */
function BelowPlay({ appId }: { appId: number }) {
  useEffect(() => placements.mountBelow(appId), [appId]);
  return <ModsCard appId={appId} placement="below" />;
}

/** Above the overview panel: only when the copy under Play is not mounted,
 * after a short grace period, and then a single line that never grows. */
function AbovePlay({ appId }: { appId: number }) {
  const [, rerender] = useState(0);
  const [grace, setGrace] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setGrace(true), ABOVE_GRACE_MS);
    const unsub = placements.subscribe(() => rerender((n) => n + 1));
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [appId]);
  if (!aboveFallbackShown(placements.hasBelow(appId), grace)) return null;
  return <ModsCard appId={appId} placement="above" />;
}

function ModsCard({ appId, placement }: { appId: number; placement: CardPlacement }) {
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
  const locked = mode === "locked";
  const now = Date.now() / 1000;
  const savesFound = Boolean(saves?.found);
  const lastBackupAt = saves?.game?.last_backup_at ?? 0;
  const card: CardInput = {
    mode,
    managed: Boolean(game),
    anticheat: ac,
    mods: game ? mods : [],
    updates: updates.size,
    offer: Boolean(guard.offer),
    undo: Boolean(guard.undo),
    savesFound,
    lastBackupAt,
  };

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
  // "Mods...": the game's full Forge page, My Mods when it has any.
  const openFull = () => (list.length > 0 ? openManager() : openStore());
  const openSetup = () => Navigation.OpenQuickAccessMenu(QuickAccessTab.Decky);
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

  const relock = () =>
    void run(async () => {
      await lockModsAgain(appId);
    });

  const restoreSaves = () =>
    void run(async () => {
      await openRestoreSaves(appId, game?.displayName ?? "this game", () => refresh(false));
    });

  const lockWhy = () =>
    showModal(<LockWhyModal appId={appId} ac={ac} onChanged={() => refresh(false)} />);

  const doAction = (a: CardAction) => {
    switch (a) {
      case "restore-mods":
        return offerRestore();
      case "undo-restore":
        return undoRestore();
      case "mods":
        return openFull();
      case "setup":
        return openSetup();
      case "why":
        return lockWhy();
      case "restore-saves":
        return restoreSaves();
    }
  };

  const chips = statusChips(card);
  const actions = compactButtons(card);
  const hint = savesHint(savesFound, lastBackupAt, now);
  const saveLine = saveBackupLine(savesFound, saves?.game, now);
  const press = rowPress(placement);
  // The line above the panel never grows: A goes where "Mods..." (or
  // "Set up...", or the lock's "Why?") would.
  const onRow =
    press === "toggle"
      ? () => setExpanded((e) => !e)
      : () => (game ? openFull() : locked ? lockWhy() : openSetup());
  const open = press === "toggle" && expanded;

  return (
    <Focusable className={CARD} flow-children="column" style={{ display: "flex", flexDirection: "column" }}>
      <style>{CSS}</style>
      <Focusable
        flow-children="row"
        style={{ display: "flex", alignItems: "center", gap: "8px", height: `${ROW_HEIGHT}px`, padding: "0 10px 0 4px" }}
      >
        <DialogButton
          className={MAIN}
          onClick={onRow}
          style={{
            flex: "1 1 auto",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            height: `${ROW_HEIGHT - 8}px`,
            padding: "0 12px",
            textAlign: "left",
            overflow: "hidden",
          }}
        >
          <span style={{ fontSize: `${CARD_TEXT.title}px`, fontWeight: 700, color: WHITE, flex: "0 0 auto" }}>Mods</span>
          {chips.map((c) => (
            <Chip key={c.text} chip={c} />
          ))}
          {hint && (
            <span className={TEXT} style={{ fontSize: `${CARD_TEXT.hint}px`, color: STEEL_MUTED, flex: "0 1 auto" }}>
              {hint}
              {saveLine?.failed && <span style={{ color: AMBER }}> · {saveLine.failed}</span>}
            </span>
          )}
          <span style={{ flex: "1 1 auto" }} />
          {press === "toggle" && (
            <span style={{ display: "flex", color: STEEL_MUTED, flex: "0 0 auto" }}>
              {open ? <FaChevronUp /> : <FaChevronDown />}
            </span>
          )}
        </DialogButton>
        {actions.map((a) => (
          <Button key={a} disabled={busy} onClick={() => doAction(a)}>
            {CARD_ACTION_LABELS[a]}
          </Button>
        ))}
      </Focusable>

      {open && (
        <Focusable
          flow-children="column"
          style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "0 14px 12px 16px" }}
        >
          {detailLines(card).map((kind) => {
            switch (kind) {
              case "lock":
                return (
                  <Line key={kind} label="Anti-cheat" text={lockSummary(ac)} color={CRIMSON_TEXT}>
                    {lockLineActions({ locked, managed: Boolean(game), enabledCount, overrideOn: false }).map((a) =>
                      a === "switch-off" ? (
                        <Button key={a} primary disabled={busy} onClick={allOff}>
                          Switch {enabledCount} off
                        </Button>
                      ) : a === "why" ? (
                        <Button key={a} onClick={lockWhy}>
                          Why?
                        </Button>
                      ) : null
                    )}
                  </Line>
                );
              case "override":
                return (
                  <Line key={kind} label="Anti-cheat" text={overrideOnLabel(ac)} color={CRIMSON_TEXT}>
                    {lockLineActions({ locked: false, managed: Boolean(game), enabledCount, overrideOn: true }).map((a) =>
                      a === "lock-again" ? (
                        <Button key={a} disabled={busy} onClick={relock}>
                          Lock mods again
                        </Button>
                      ) : a === "why" ? (
                        <Button key={a} onClick={lockWhy}>
                          Why?
                        </Button>
                      ) : null
                    )}
                  </Line>
                );
              case "offer":
                return (
                  <Line key={kind} label="Crashes" text="Closed early twice since its mods changed" color={AMBER}>
                    <Button primary disabled={busy} onClick={offerRestore}>
                      Restore...
                    </Button>
                    <Button disabled={busy} onClick={() => void run(async () => void (await forgeGuardDismiss(appId)))}>
                      Not now
                    </Button>
                    <Button
                      onClick={() =>
                        showWhy(
                          "Restore last working mods?",
                          `${game?.displayName ?? "This game"} closed early twice since its mods changed. ` +
                            "Going back only switches mods on and off; nothing is deleted."
                        )
                      }
                    >
                      Why?
                    </Button>
                  </Line>
                );
              case "undo":
                return (
                  <Line key={kind} label="Crashes" text="Last working mods restored">
                    <Button disabled={busy} onClick={undoRestore}>
                      Undo restore
                    </Button>
                  </Line>
                );
              case "mods":
                return (
                  <ModList
                    key={kind}
                    list={list}
                    loaded={Boolean(mods)}
                    updates={updates}
                    busy={busy}
                    locked={locked}
                    onToggle={toggle}
                    onOpen={openMod}
                    onStore={openStore}
                    onManager={openManager}
                  />
                );
              case "saves":
                return saveLine ? (
                  <Line
                    key={kind}
                    label="Saves"
                    text={
                      <>
                        {saveLine.text}
                        {saveLine.failed && <span style={{ color: AMBER }}> · {saveLine.failed}</span>}
                      </>
                    }
                  >
                    <Button disabled={busy} onClick={restoreSaves}>
                      Restore saves...
                    </Button>
                  </Line>
                ) : null;
              case "upscaling":
                return <UpscalingEntry key={kind} appId={appId} game={game} />;
              case "loadorder":
                return <LoadOrderEntry key={kind} appId={appId} game={game} locked={locked} />;
              case "setup":
                return (
                  <Line key={kind} label="Setup" text="Mods are not set up for this game yet">
                    <Button onClick={openSetup}>Set up...</Button>
                  </Line>
                );
            }
          })}
        </Focusable>
      )}
    </Focusable>
  );
}

/** The details' mods: the count with Add mods and My Mods, then up to
 * GAME_PAGE_ROWS rows (updates first, then the ones that are on), each a
 * switch plus Open / Update. The rest are on My Mods. */
function ModList({
  list,
  loaded,
  updates,
  busy,
  locked,
  onToggle,
  onOpen,
  onStore,
  onManager,
}: {
  list: InstalledMod[];
  loaded: boolean;
  updates: Set<string>;
  busy: boolean;
  locked: boolean;
  onToggle: (m: InstalledMod) => void;
  onOpen: (m: InstalledMod) => void;
  onStore: () => void;
  onManager: () => void;
}) {
  const shown = rowsToShow(list, updates);
  return (
    <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <Line label="Mods" text={loaded ? countLabel(list) : "Reading..."}>
        {!locked && (
          <Button primary disabled={busy} onClick={onStore}>
            Add mods
          </Button>
        )}
        {list.length > 0 && (
          <Button onClick={onManager}>{list.length > shown.length ? `All ${list.length}...` : "My Mods"}</Button>
        )}
      </Line>
      {shown.map((m) => {
        const hasUpdate = updates.has(m.folder);
        const canSwitch = m.togglable !== false;
        return (
          <Focusable key={m.folder} flow-children="row" style={{ display: "flex", gap: "8px" }}>
            <DialogButton
              className={ROW}
              disabled={busy || !canSwitch}
              onClick={() => onToggle(m)}
              style={{
                flex: "1 1 auto",
                display: "flex",
                alignItems: "center",
                gap: "10px",
                height: "40px",
                padding: "0 12px",
                textAlign: "left",
                fontSize: `${CARD_TEXT.body}px`,
              }}
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
              <span className={TEXT} style={{ flex: "1 1 auto", color: WHITE }}>
                {m.name ?? m.folder}
              </span>
              {m.version && <span style={{ fontSize: `${CARD_TEXT.hint}px`, color: STEEL_MUTED }}>{m.version}</span>}
              {hasUpdate && <Chip chip={{ text: "Update", tone: "amber" }} />}
              <span style={{ fontSize: `${CARD_TEXT.hint}px`, minWidth: "28px", textAlign: "right" }}>
                {m.togglable === false ? "always on" : m.enabled ? "On" : "Off"}
              </span>
            </DialogButton>
            {m.mod_id ? (
              <Button disabled={busy} onClick={() => onOpen(m)}>
                {hasUpdate ? "Update" : "Open"}
              </Button>
            ) : null}
          </Focusable>
        );
      })}
    </Focusable>
  );
}

// ---- Upscaling (OptiScaler) ---------------------------------------------------
// One line in the details, for any game the section shows. Install, update,
// switch upscaler; the rarer actions (another proxy name, remove) are in
// "More...". Refused games show the crimson line and "Why?": there is no
// override for DLL injection.

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
  const nextName = NEXT_PROXY[inst.proxy ?? ""] ?? "dxgi.dll";
  const otherName = () =>
    void act(() => install(inst.upscaler || st.upscalers.default, nextName), "Reinstalled under another name.");
  const keep = () => void act(async () => ({ ...(await forgeOptiScalerDismiss(appId)) }), "Kept.");
  const more = () =>
    showModal(
      <MoreModal
        title="OptiScaler"
        body={`${line.text}. If the game ignores it, try another file name; Remove puts the game's own files back.`}
        actions={[
          { label: `Use ${nextName} instead`, run: otherName },
          { label: "Remove", run: remove },
        ]}
      />
    );

  const color = line.tone === "refused" || line.tone === "suspect" ? CRIMSON_TEXT : line.tone === "installed" ? GREEN : STEEL_MUTED;
  return (
    <Line label="Upscaling" text={line.text} color={color}>
      {line.tone === "refused" && st.refusal?.detail && (
        <Button onClick={() => showWhy("Upscaling (OptiScaler)", st.refusal?.detail ?? "")}>Why?</Button>
      )}
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
      {line.tone === "suspect" && (
        <Button onClick={() => showWhy("OptiScaler", "Removing it puts the game's own files back. Nothing else changes.")}>
          Why?
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
        <Button disabled={busy} onClick={more}>
          More...
        </Button>
      )}
      {line.tone === "refused" && inst.installed && (
        <Button disabled={busy} onClick={remove}>
          Remove
        </Button>
      )}
    </Line>
  );
}

/** A small modal with a line of explanation and a few rarer actions. */
function MoreModal({
  title,
  body,
  actions,
  closeModal,
}: {
  title: string;
  body: string;
  actions: { label: string; run: () => void }[];
  closeModal?: () => void;
}) {
  return (
    <WhyModal title={title} body={body} closeModal={closeModal}>
      {actions.map((a) => (
        <ButtonItem
          key={a.label}
          layout="below"
          onClick={() => {
            closeModal?.();
            a.run();
          }}
        >
          {a.label}
        </ButtonItem>
      ))}
    </WhyModal>
  );
}

// ---- Load order (LOOT rules) and profiles -------------------------------------
// Skyrim SE, Fallout 4, Starfield and Oblivion Remastered only. One line with
// the counts, problems and the current profile; the plugin list and where the
// rules come from are on the Load order page (opened from here; B comes back).
// Sorting and profile switches are refused by the backend while the game
// runs, and on a locked game the writers are not offered.

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
  const text = (
    <>
      {st.counts?.active ?? 0} of {st.counts?.plugins ?? 0} on
      {st.current_profile ? ` · ${st.current_profile}` : ""}
      {" · "}
      <span style={{ color: sum.tone === "error" ? CRIMSON_TEXT : sum.tone === "warn" ? AMBER : GREEN }}>{sum.text}</span>
    </>
  );
  return (
    <Line label="Load order" text={text}>
      <Button onClick={() => openForgeLoadOrder(scope)}>Load order...</Button>
      {!locked && (
        <Button disabled={busy} onClick={() => void sort()}>
          Sort
        </Button>
      )}
      {!locked && (
        <Button disabled={busy} onClick={() => openProfiles(scope, st, refresh)}>
          Profiles...
        </Button>
      )}
    </Line>
  );
}
