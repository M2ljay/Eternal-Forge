// Forge's save backups through Ludusavi (optional): the backup before the
// crash guard's restore and Undo, the game page's "Restore saves..." list,
// and the Settings rows. The backups before installs and switches happen in
// the backend (main.py, _wrap_save_backups); this side only shows them.
import { ConfirmModal, DialogButton, Focusable, ModalRoot, SliderField, ToggleField, showModal } from "@decky/ui";
import { addEventListener, removeEventListener, toaster } from "@decky/api";
import { useEffect, useState } from "react";

import {
  SaveBackupEntry,
  SaveBackupStatus,
  forgeSaveBackup,
  forgeSaveBackupList,
  forgeSaveBackupSettings,
  forgeSaveBackupStatus,
  forgeSaveRestore,
} from "./api";
import {
  SAVE_BACKUP_HINT,
  backupFailToast,
  backupRowLabel,
  restoreConfirmBody,
  skipWindowLabel,
} from "./forgeRules";
import { isGameRunning } from "./steam";
import { STEEL_MUTED } from "./palette";

// ---- Backend events ----------------------------------------------------------

type BackupEvent = { ok: boolean; error: string; reason: string; at: number };
const listeners = new Set<(appId: number) => void>();

/** Called when a backup ran for a game (the game page re-reads its line). */
export function subscribeSaveBackups(l: (appId: number) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The backend says when a backup ran: a failure gets one small toast (the
 * mod change went ahead regardless), and the game page refreshes. */
export function startSaveBackupEvents(): () => void {
  const handler = (appId: number, e: BackupEvent) => {
    if (e && !e.ok) toaster.toast(backupFailToast(e.error));
    for (const l of listeners) l(appId);
  };
  const listener = addEventListener<[appId: number, e: BackupEvent]>("forge_save_backup", handler);
  return () => removeEventListener("forge_save_backup", listener);
}

/** Before the crash guard's restore or Undo. Never throws and never stops
 * what follows: a failure is reported by the backend's event. */
export async function backupBeforeChange(appId: number, gameName: string, reason: string): Promise<void> {
  try {
    await forgeSaveBackup(appId, gameName, reason);
  } catch {
    /* the change goes ahead */
  }
}

// ---- Restore saves... --------------------------------------------------------

function BackupListModal({
  gameName,
  backups,
  path,
  onPick,
  closeModal,
}: {
  gameName: string;
  backups: SaveBackupEntry[];
  path: string;
  onPick: (b: SaveBackupEntry, label: string) => void;
  closeModal?: () => void;
}) {
  const now = Date.now() / 1000;
  return (
    <ModalRoot closeModal={closeModal}>
      <h3 style={{ marginTop: 0 }}>Restore saves: {gameName}</h3>
      <div style={{ fontSize: "13px", color: STEEL_MUTED, marginBottom: "8px" }}>
        Ludusavi's backups, newest first{path ? ` (${path})` : ""}. Your current saves are backed up before
        anything is restored.
      </div>
      <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {backups.map((b) => {
          const label = backupRowLabel(b, now);
          return (
            <DialogButton
              key={b.id}
              style={{ textAlign: "left" }}
              onClick={() => {
                closeModal?.();
                onPick(b, label);
              }}
            >
              {label}
            </DialogButton>
          );
        })}
      </Focusable>
    </ModalRoot>
  );
}

/** List Ludusavi's backups of the game, pick one, confirm, restore. The
 * backend takes a fresh backup first and refuses to restore without it. */
export async function openRestoreSaves(appId: number, gameName: string, onDone: () => void): Promise<void> {
  const r = await forgeSaveBackupList(appId, gameName);
  if (!r.ok) {
    toaster.toast({ title: "No save backups to show", body: r.error ?? "" });
    return;
  }
  const backups = r.backups ?? [];
  if (backups.length === 0) {
    toaster.toast({ title: "No save backups yet", body: `Ludusavi has no backups of ${gameName}.` });
    return;
  }
  const restore = (b: SaveBackupEntry, label: string) => {
    showModal(
      <ConfirmModal
        strTitle="Restore this save backup?"
        strDescription={restoreConfirmBody(gameName, label)}
        strOKButtonText="Restore"
        strCancelButtonText="Cancel"
        onOK={async () => {
          if (isGameRunning(appId)) {
            toaster.toast({ title: "Close the game first", body: "Saves are not restored while it runs." });
            return;
          }
          try {
            const res = await forgeSaveRestore(appId, gameName, b.id, true);
            toaster.toast(
              res.ok
                ? { title: "Saves restored", body: "Your saves from before are in Ludusavi's backups." }
                : { title: "Saves not restored", body: res.error ?? "" }
            );
          } catch (e) {
            toaster.toast({ title: "Saves not restored", body: String(e) });
          } finally {
            onDone();
          }
        }}
      />
    );
  };
  showModal(<BackupListModal gameName={gameName} backups={backups} path={r.path ?? ""} onPick={restore} />);
}

// ---- Settings ------------------------------------------------------------------

/** Under Game page: the switch and the skip window, or one calm line when
 * Ludusavi is not installed. */
export function SaveBackupSettings() {
  const [status, setStatus] = useState<SaveBackupStatus | undefined>();
  useEffect(() => {
    forgeSaveBackupStatus(0, true)
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  if (!status) return null;
  if (!status.found) {
    return (
      <div style={{ fontSize: "13px", color: STEEL_MUTED, padding: "8px 0" }}>
        {SAVE_BACKUP_HINT} ({status.install_command}).
      </div>
    );
  }
  const save = (enabled: boolean, minutes: number) => {
    setStatus({ ...status, enabled, skip_minutes: minutes });
    forgeSaveBackupSettings(enabled, minutes).catch(() => undefined);
  };
  return (
    <>
      <ToggleField
        label="Back up saves before mod changes"
        description="Ludusavi backs up a game's saves before Forge installs or switches on mods, and before a crash restore or Undo. Backups go to Ludusavi's own folder. A failed backup never stops the mod change."
        checked={status.enabled}
        onChange={(v: boolean) => save(v, status.skip_minutes)}
      />
      {status.enabled && (
        <SliderField
          label={skipWindowLabel(status.skip_minutes)}
          description="A collection of many mods is one backup, not one per mod."
          value={status.skip_minutes}
          min={0}
          max={120}
          step={5}
          showValue={false}
          onChange={(v: number) => save(status.enabled, v)}
        />
      )}
    </>
  );
}
