// New VR mod releases on the Updates page: MRSURVIV0R's VR HUB (with the
// user's games its notes name), VR mods followed on GitHub, and VR mods
// added or updated on Nexus for the plugin's games.
import { ConfirmModal, DialogButton, Field, Focusable, ModalRoot, Navigation, TextField, showModal } from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";

import { VrRelease, addVrRepo, getVrReleases, markVrReleasesSeen, removeVrRepo } from "./api";

const SMALL = { minWidth: "0", width: "auto", padding: "6px 14px", fontSize: "12.5px", flexShrink: 0 } as const;

function ago(ts: number): string {
  if (!ts) return "";
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function WatchModal({ onDone, closeModal }: { onDone: () => void; closeModal?: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Field label="Follow a VR mod on GitHub" bottomSeparator="none">
        Paste the mod's GitHub page (github.com/owner/project). Its new releases will show here.
      </Field>
      <TextField label="GitHub link" value={text} onChange={(e) => setText(e.target.value)} />
      <DialogButton
        disabled={busy || !text.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await addVrRepo(text);
            toaster.toast({ title: r.ok ? `Following ${r.repo}` : "Couldn't follow it", body: r.error ?? "" });
            if (r.ok) {
              closeModal?.();
              onDone();
            }
          } finally {
            setBusy(false);
          }
        }}
      >
        Follow
      </DialogButton>
    </ModalRoot>
  );
}

export function VrReleases() {
  const [data, setData] = useState<Awaited<ReturnType<typeof getVrReleases>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const load = (force: boolean) => {
    setBusy(true);
    void getVrReleases(force)
      .then(setData)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  useEffect(() => load(false), []);

  const items: VrRelease[] = data?.items ?? [];
  const shown = all ? items : items.slice(0, 8);
  return (
    <Focusable style={{ margin: "22px 0 12px", maxWidth: "640px" }}>
      <h3 style={{ margin: "0 0 4px" }}>
        VR releases{data?.new ? ` · ${data.new} new` : ""}
      </h3>
      <div style={{ fontSize: "12.5px", opacity: 0.65, marginBottom: "8px" }}>
        MRSURVIV0R's VR HUB, VR mods you follow on GitHub
        {data?.nexus ? ", and VR mods on Nexus for your modded games" : ""} - from the last 45 days.
        {data?.checked ? ` Checked ${ago(data.checked)}.` : ""}
      </div>
      {!data && <div style={{ opacity: 0.8 }}>Checking…</div>}
      {data && items.length === 0 && <div style={{ opacity: 0.8 }}>No VR releases in the last 45 days.</div>}
      <Focusable style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {shown.map((it) => (
          <Focusable
            key={it.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 12px",
              background: it.new ? "rgba(218, 142, 53, 0.12)" : "rgba(255,255,255,0.05)",
              borderRadius: "4px",
            }}
          >
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <div style={{ fontSize: "13.5px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {it.new ? "NEW · " : ""}
                {it.title}
              </div>
              <div style={{ fontSize: "12px", opacity: 0.7 }}>
                {[
                  it.source === "hub" ? "VR HUB" : it.source === "github" ? "GitHub" : `Nexus · ${it.domain}`,
                  it.source === "nexus" ? (it.added ? "new mod" : `updated${it.version ? ` to ${it.version}` : ""}`) : "",
                  ago(it.date),
                  it.games.length ? `mentions ${it.games.join(", ")}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {it.sub && <div style={{ fontSize: "12px", opacity: 0.6, marginTop: "2px" }}>{it.sub}</div>}
            </div>
            {it.url && (
              <DialogButton style={SMALL} onClick={() => Navigation.NavigateToExternalWeb(it.url)}>
                Open
              </DialogButton>
            )}
          </Focusable>
        ))}
      </Focusable>
      <Focusable style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
        {items.length > 8 && (
          <DialogButton style={SMALL} onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${items.length}`}
          </DialogButton>
        )}
        {!!data?.new && (
          <DialogButton
            style={SMALL}
            onClick={async () => {
              await markVrReleasesSeen();
              load(false);
            }}
          >
            Mark all as seen
          </DialogButton>
        )}
        <DialogButton style={SMALL} disabled={busy} onClick={() => load(true)}>
          {busy ? "Checking…" : "Check now"}
        </DialogButton>
        <DialogButton style={SMALL} onClick={() => showModal(<WatchModal onDone={() => load(true)} />)}>
          Follow a GitHub VR mod…
        </DialogButton>
        {(data?.repos ?? []).map((r) => (
          <DialogButton
            key={r}
            style={SMALL}
            onClick={() =>
              showModal(
                <ConfirmModal
                  strTitle={`Stop following ${r}?`}
                  strOKButtonText="Stop following"
                  onOK={async () => {
                    await removeVrRepo(r);
                    load(true);
                  }}
                />
              )
            }
          >
            ✕ {r}
          </DialogButton>
        ))}
      </Focusable>
      {!!data?.errors?.length && (
        <div style={{ fontSize: "11.5px", opacity: 0.5, marginTop: "6px" }}>
          Couldn't check: {data.errors.slice(0, 3).join("; ")}
        </div>
      )}
    </Focusable>
  );
}
