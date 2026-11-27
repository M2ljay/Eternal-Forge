// A folder picker driven by the controller alone (no keyboard): the drives,
// then one level at a time, "Up" to go back, "Use this folder" to pick.
// Used for games Steam has no install record for (non-Steam shortcuts,
// other launchers) and for a mods folder Forge could not guess.
import { ButtonItem, DialogButton, Focusable, ModalRoot, showModal } from "@decky/ui";
import { useEffect, useState } from "react";

import { forgeListFolders } from "./api";
import { CRIMSON, CRIMSON_TEXT, STEEL_MUTED, WHITE } from "./palette";

/** "C:\\Games\\X" inside root "C:\\Games" -> "X"; undefined when outside. */
export function relativeTo(root: string, path: string): string | undefined {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const p = norm(path);
  if (!r || p.toLowerCase() === r.toLowerCase()) return undefined;
  if (!p.toLowerCase().startsWith(r.toLowerCase() + "/")) return undefined;
  return p.slice(r.length + 1);
}

function joinPath(base: string, name: string): string {
  if (!base) return name;
  const sep = base.includes("\\") || /^[A-Za-z]:/.test(base) ? "\\" : "/";
  return base.endsWith(sep) ? base + name : base + sep + name;
}

function PickerModal({
  title,
  hint,
  start,
  root,
  pickLabel,
  onPick,
  closeModal,
}: {
  title: string;
  hint?: string;
  start: string;
  root?: string;
  pickLabel: string;
  onPick: (path: string) => void | Promise<void>;
  closeModal?: () => void;
}) {
  const [path, setPath] = useState(start);
  const [folders, setFolders] = useState<string[] | undefined>();
  const [parent, setParent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setFolders(undefined);
    setError("");
    forgeListFolders(path)
      .then((r) => {
        if (!live) return;
        if (!r.ok) {
          setError(r.error ?? "Could not read this folder");
          setFolders([]);
          return;
        }
        setFolders(r.folders ?? []);
        setParent(r.parent ?? "");
        if (r.path !== undefined && r.path !== path && r.path) setPath(r.path);
      })
      .catch((e) => live && (setError(String(e)), setFolders([])));
    return () => {
      live = false;
    };
  }, [path]);

  // Never above the root when one is given (a mods folder inside the game).
  const atRoot = root ? path.replace(/[\\/]+$/, "").toLowerCase() === root.replace(/[\\/]+$/, "").toLowerCase() : !path;
  const canPick = Boolean(path) && (!root || !atRoot);

  return (
    <ModalRoot closeModal={closeModal}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {hint && <div style={{ fontSize: "13px", color: STEEL_MUTED, marginBottom: "8px" }}>{hint}</div>}
      <div
        style={{
          fontSize: "14px",
          color: WHITE,
          borderLeft: `3px solid ${CRIMSON}`,
          padding: "4px 10px",
          marginBottom: "8px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {path || "This PC"}
      </div>
      {error && <div style={{ color: CRIMSON_TEXT, fontSize: "13px", marginBottom: "6px" }}>{error}</div>}
      <Focusable style={{ display: "flex", gap: "8px", marginBottom: "8px" }} flow-children="row">
        <DialogButton
          disabled={!canPick || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onPick(path);
              closeModal?.();
            } finally {
              setBusy(false);
            }
          }}
          style={{ flex: "1 1 0" }}
        >
          {pickLabel}
        </DialogButton>
        <DialogButton disabled={atRoot || busy} onClick={() => setPath(parent)} style={{ flex: "1 1 0" }}>
          Up
        </DialogButton>
      </Focusable>
      {folders === undefined && <div style={{ color: STEEL_MUTED }}>Reading...</div>}
      {folders?.length === 0 && !error && <div style={{ color: STEEL_MUTED }}>No folders here.</div>}
      {folders?.map((name) => (
        <ButtonItem key={name} layout="below" onClick={() => setPath(path ? joinPath(path, name) : name)}>
          {name}
        </ButtonItem>
      ))}
    </ModalRoot>
  );
}

/** Opens the picker. `root` keeps it inside one folder (start there). */
export function pickFolder(o: {
  title: string;
  hint?: string;
  start?: string;
  root?: string;
  pickLabel?: string;
  onPick: (path: string) => void | Promise<void>;
}): void {
  showModal(
    <PickerModal
      title={o.title}
      hint={o.hint}
      start={o.start ?? o.root ?? ""}
      root={o.root}
      pickLabel={o.pickLabel ?? "Use this folder"}
      onPick={o.onPick}
    />
  );
}
