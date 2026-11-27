// Forge's load order on the game page: opening the panel, LOOT sorting and
// deploy profiles (named sets of enabled mods plus a load order).
//
// A profile switch, in order: refuse while the game runs; save the live state
// into the current profile (profiles follow what you change, as in other mod
// managers); ask the backend which mods to switch; take a Ludusavi backup;
// switch the mods one at a time through install.ts, the same path as every
// other switch (anti-cheat lock, save backup, Modded collection); then write
// the profile's load order. Controller only; the on-screen keyboard appears
// only for "Type a name", and the preset names need no typing at all.
import { ConfirmModal, DialogButton, Focusable, ModalRoot, TextField, showModal } from "@decky/ui";
import { toaster } from "@decky/api";
import { useState } from "react";

import {
  ForgeLoadOrderState,
  forgeLoStatus,
  forgeProfileApplyOrder,
  forgeProfileDelete,
  forgeProfilePlan,
  forgeProfileSave,
  getInstalledMods,
} from "./api";
import { profileSwitchBlocked, profileSwitchSummary } from "./forgeRules";
import { FORGE_LOAD_ORDER_ROUTE, ForgeLoScope, setForgeLoadOrderScope } from "./forgeLoScope";
import { modeParams } from "./games";
import { toggleMod } from "./install";
import { backupBeforeChange } from "./SaveBackup";
import { notifyGameStateChanged } from "./state";
import { isGameRunning } from "./steam";
import { pushFromGamePage } from "./Tabs";
import { CRIMSON_TEXT, STEEL_MUTED } from "./palette";

const PRESETS = ["Vanilla+", "Full modlist", "Light", "Testing"];

/** Open the Load order panel for one game, from its game page. */
export function openForgeLoadOrder(s: ForgeLoScope): void {
  setForgeLoadOrderScope(s);
  pushFromGamePage(FORGE_LOAD_ORDER_ROUTE);
}

type ModArg = { folder: string; enabled: boolean; togglable?: boolean };

async function currentMods(s: ForgeLoScope): Promise<ModArg[]> {
  const g = s.game;
  if (!g) return [];
  const r = await getInstalledMods(g.nexusDomain, g.installDirName, g.modsSubdir, ...modeParams(g), g.protectedModFolders ?? []);
  return (r.ok ? r.mods ?? [] : []).map((m) => ({ folder: m.folder, enabled: m.enabled, togglable: m.togglable !== false }));
}

export async function saveProfile(s: ForgeLoScope, name: string): Promise<boolean> {
  const r = await forgeProfileSave(s.appId, name, await currentMods(s), s.domain, s.installDir);
  toaster.toast(
    r.ok
      ? { title: `Profile saved: ${r.name}`, body: `${r.mods ?? 0} mods on, ${r.plugins ?? 0} plugins in its load order.` }
      : { title: "Profile not saved", body: r.error ?? "" }
  );
  return r.ok;
}

let switching = false;

export async function switchProfile(s: ForgeLoScope, name: string): Promise<void> {
  const blocked = profileSwitchBlocked(isGameRunning(s.appId) ? s.appId : undefined, s.appId, switching);
  if (blocked) {
    toaster.toast({ title: "Profile not switched", body: blocked });
    return;
  }
  switching = true;
  try {
    const mods = await currentMods(s);
    const status = await forgeLoStatus(s.appId, s.domain, s.installDir);
    const current = status.current_profile ?? "";
    if (current && current !== name) {
      await forgeProfileSave(s.appId, current, mods, s.domain, s.installDir);
    }
    const plan = await forgeProfilePlan(s.appId, name, mods, s.domain, s.installDir);
    if (!plan.ok || plan.running) {
      toaster.toast({ title: "Profile not switched", body: plan.error ?? "" });
      return;
    }
    await backupBeforeChange(s.appId, s.name, "profile switch");
    const failed: string[] = [];
    for (const c of plan.changes ?? []) {
      if (!s.game) {
        failed.push(`${c.folder}: Forge does not manage this game's mods`);
        continue;
      }
      const r = await toggleMod(s.game, c.folder, c.enabled, c.enabled ? undefined : `Profile ${name}`);
      if (!r.ok) failed.push(`${c.folder}: ${r.error ?? "failed"}`);
    }
    const applied = await forgeProfileApplyOrder(s.appId, name, s.domain, s.installDir);
    const notes = applied.notes ?? (applied.error ? [applied.error] : []);
    toaster.toast(profileSwitchSummary(name, plan, failed, applied.ok, notes));
  } catch (e) {
    toaster.toast({ title: "Profile not switched", body: String(e) });
  } finally {
    switching = false;
    notifyGameStateChanged();
  }
}

function NameModal({
  taken,
  onPick,
  closeModal,
}: {
  taken: string[];
  onPick: (name: string) => void;
  closeModal?: () => void;
}) {
  const [typed, setTyped] = useState("");
  const free = PRESETS.filter((p) => !taken.includes(p));
  const pick = (n: string) => {
    closeModal?.();
    onPick(n);
  };
  return (
    <ModalRoot closeModal={closeModal}>
      <h3 style={{ marginTop: 0 }}>Save the current setup as...</h3>
      <div style={{ fontSize: "13px", color: STEEL_MUTED, marginBottom: "8px" }}>
        The mods that are on now and the load order. Pick a name, or type one.
      </div>
      <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {free.map((p) => (
          <DialogButton key={p} onClick={() => pick(p)} style={{ textAlign: "left" }}>
            {p}
          </DialogButton>
        ))}
        <TextField
          label="Type a name"
          value={typed}
          onChange={(e) => setTyped(e?.target?.value ?? "")}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLElement).blur();
          }}
        />
        <DialogButton disabled={!typed.trim()} onClick={() => pick(typed.trim())}>
          Save as "{typed.trim() || "..."}"
        </DialogButton>
      </Focusable>
    </ModalRoot>
  );
}

function ProfilesModal({
  scope,
  profiles,
  current,
  onDone,
  closeModal,
}: {
  scope: ForgeLoScope;
  profiles: string[];
  current: string;
  onDone: () => void;
  closeModal?: () => void;
}) {
  const close = () => closeModal?.();
  const confirmSwitch = (name: string) => {
    close();
    showModal(
      <ConfirmModal
        strTitle={`Switch to ${name}?`}
        strDescription={
          `Forge backs up ${scope.name}'s saves (Ludusavi), switches mods on and off to match ${name}, ` +
          "and rewrites the load order. " +
          (current ? `${current} keeps what you have now.` : "Save the current setup first if you want to come back to it.")
        }
        strOKButtonText="Switch"
        strCancelButtonText="Cancel"
        onOK={() => void switchProfile(scope, name).then(onDone)}
      />
    );
  };
  const confirmDelete = (name: string) => {
    close();
    showModal(
      <ConfirmModal
        strTitle={`Delete the profile ${name}?`}
        strDescription="Only the profile goes. No mod is switched or removed."
        strOKButtonText="Delete"
        strCancelButtonText="Cancel"
        onOK={() => void forgeProfileDelete(scope.appId, name, scope.domain).then(onDone)}
      />
    );
  };
  const saveNew = () => {
    close();
    showModal(<NameModal taken={profiles} onPick={(n) => void saveProfile(scope, n).then(onDone)} />);
  };
  return (
    <ModalRoot closeModal={closeModal}>
      <h3 style={{ marginTop: 0 }}>Profiles: {scope.name}</h3>
      <div style={{ fontSize: "13px", color: STEEL_MUTED, marginBottom: "8px" }}>
        Each profile is a set of mods that are on and a load order. Switching backs up saves first and is
        refused while the game runs.
      </div>
      <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {profiles.length === 0 && <div style={{ fontSize: "13px" }}>No profiles yet.</div>}
        {profiles.map((p) => (
          <Focusable key={p} flow-children="row" style={{ display: "flex", gap: "6px" }}>
            <DialogButton
              style={{ flex: "1 1 auto", textAlign: "left" }}
              disabled={p === current}
              onClick={() => confirmSwitch(p)}
            >
              {p}
              {p === current ? "  (current)" : ""}
            </DialogButton>
            <DialogButton style={{ width: "auto", minWidth: 0, flex: "0 0 auto" }} onClick={() => confirmDelete(p)}>
              Delete
            </DialogButton>
          </Focusable>
        ))}
        {current && (
          <DialogButton
            onClick={() => {
              close();
              void saveProfile(scope, current).then(onDone);
            }}
          >
            Update {current} with the current setup
          </DialogButton>
        )}
        <DialogButton onClick={saveNew}>Save the current setup as a new profile...</DialogButton>
      </Focusable>
      {!scope.game && (
        <div style={{ fontSize: "12px", color: CRIMSON_TEXT, marginTop: "8px" }}>
          Forge does not manage this game's mods, so a profile here holds the load order only.
        </div>
      )}
    </ModalRoot>
  );
}

/** The Profiles picker. */
export function openProfiles(scope: ForgeLoScope, state: ForgeLoadOrderState | undefined, onDone: () => void): void {
  showModal(
    <ProfilesModal
      scope={scope}
      profiles={state?.profiles ?? []}
      current={state?.current_profile ?? ""}
      onDone={onDone}
    />
  );
}
