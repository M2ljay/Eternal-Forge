// The GameBanana store for one game: link the Steam game to its GameBanana
// game (by name automatically, else picked or typed), then browse, search
// and sort its mods. Opening a mod goes to GameBananaModPage.
import {
  DialogButton,
  Dropdown,
  Focusable,
  ScrollPanelGroup,
  TextField,
} from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { FaEye, FaThumbsUp } from "react-icons/fa";

import {
  GbGame,
  GbModSummary,
  getShowAdult,
  gbGetGame,
  gbLinkGame,
  gbListMods,
  gbSearchGames,
  gbUnlinkGame,
} from "./api";
import { AdultBadge, PageBackdrop, SectionHeading } from "./chrome";
import { fmtDate, getGbGame, openGameBananaMod } from "./gamebanana";
import { TabBar, handleTabButtons, popOurPage } from "./Tabs";
import { PAGE_SCROLLER } from "./theme";
import { alpha, BLACK, CRIMSON_TEXT, GREEN, GUNMETAL_RAISED, STEEL, WHITE } from "./palette";

const Scroller: any = ScrollPanelGroup;

const SORTS = [
  { data: "default", label: "Default" },
  { data: "updated", label: "Recently updated" },
  { data: "new", label: "Newest" },
  { data: "liked", label: "Most liked" },
  { data: "downloaded", label: "Most downloaded" },
  { data: "viewed", label: "Most viewed" },
];

function GbTile({
  mod,
  blur,
  onOpen,
}: {
  mod: GbModSummary;
  blur: boolean;
  onOpen: () => void;
}) {
  const blurred = blur && mod.nsfw;
  return (
    <Focusable
      onActivate={onOpen}
      style={{ background: alpha(WHITE, 0.06), borderRadius: "6px", overflow: "hidden" }}
    >
      <div style={{ position: "relative", overflow: "hidden", aspectRatio: "16 / 9", background: GUNMETAL_RAISED }}>
        {mod.thumbnail && (
          <img
            src={mod.thumbnail}
            alt={mod.name}
            loading="lazy"
            decoding="async"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
              ...(blurred ? { filter: "blur(16px)", transform: "scale(1.1)" } : {}),
            }}
          />
        )}
        {blurred && <AdultBadge />}
        {mod.installed && (
          <div
            style={{
              position: "absolute",
              top: "6px",
              right: "6px",
              padding: "1px 7px",
              borderRadius: "3px",
              fontSize: "9.5px",
              fontWeight: 700,
              background: GREEN,
              color: BLACK,
            }}
          >
            INSTALLED
          </div>
        )}
      </div>
      <div style={{ padding: "8px 10px" }}>
        <div style={{ fontWeight: 600, fontSize: "14px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {mod.name}
        </div>
        <div style={{ fontSize: "12px", opacity: 0.7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {mod.author || "unknown"}
          {mod.category ? ` · ${mod.category}` : ""}
        </div>
        <div style={{ fontSize: "12px", opacity: 0.7, display: "flex", gap: "10px", alignItems: "center" }}>
          <span style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
            <FaThumbsUp size={10} /> {mod.likes.toLocaleString()}
          </span>
          <span style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
            <FaEye size={10} /> {mod.views.toLocaleString()}
          </span>
          {mod.updated ? <span>{fmtDate(mod.updated)}</span> : null}
        </div>
      </div>
    </Focusable>
  );
}

/** Not linked yet: the name matches GameBanana offered, a game search, and
 * a box for a gamebanana.com/games/... link or id. */
function LinkGame({
  appId,
  displayName,
  candidates,
  onLinked,
}: {
  appId: number;
  displayName: string;
  candidates: GbGame[];
  onLinked: (g: GbGame) => void;
}) {
  const [query, setQuery] = useState(displayName);
  const [found, setFound] = useState<GbGame[]>(candidates);
  const [ref, setRef] = useState("");
  const [note, setNote] = useState<string | undefined>();

  const link = async (r: string, name: string) => {
    setNote(undefined);
    const res = await gbLinkGame(appId, r, name);
    if (res.ok && res.linked) onLinked(res.linked);
    else setNote(res.error ?? "Could not link");
  };

  return (
    <div>
      <SectionHeading title="Which GameBanana game is this?" />
      <div style={{ opacity: 0.8, fontSize: "13px", marginBottom: "10px" }}>
        No GameBanana game is named exactly “{displayName}”. Pick it below, search, or paste its
        gamebanana.com/games/… link. The choice is remembered for this game.
      </div>
      <Focusable style={{ display: "flex", gap: "10px", alignItems: "flex-end", marginBottom: "10px" }}>
        <div style={{ flexGrow: 1 }}>
          <TextField label="Search GameBanana games" value={query} onChange={(e) => setQuery(e?.target?.value ?? "")} />
        </div>
        <DialogButton
          style={{ width: "160px", minWidth: 0 }}
          onClick={async () => {
            const r = await gbSearchGames(query);
            if (r.ok) setFound(r.games ?? []);
            else setNote(r.error);
          }}
        >
          Search
        </DialogButton>
      </Focusable>
      <Focusable style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {found.map((g) => (
          <DialogButton key={g.id} onClick={() => link(String(g.id), g.name)} style={{ textAlign: "left" }}>
            {g.name} <span style={{ opacity: 0.5 }}>· #{g.id}</span>
          </DialogButton>
        ))}
        {found.length === 0 && <div style={{ opacity: 0.7, padding: "6px 0" }}>No games found.</div>}
      </Focusable>
      <Focusable style={{ display: "flex", gap: "10px", alignItems: "flex-end", marginTop: "14px" }}>
        <div style={{ flexGrow: 1 }}>
          <TextField label="GameBanana game link or id" value={ref} onChange={(e) => setRef(e?.target?.value ?? "")} />
        </div>
        <DialogButton style={{ width: "160px", minWidth: 0 }} onClick={() => link(ref, "")}>
          Link
        </DialogButton>
      </Focusable>
      {note && <div style={{ color: CRIMSON_TEXT, marginTop: "8px" }}>{note}</div>}
    </div>
  );
}

export function GameBananaPage() {
  const game = getGbGame();
  const [linked, setLinked] = useState<GbGame | null | undefined>(undefined);
  const [candidates, setCandidates] = useState<GbGame[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [mods, setMods] = useState<GbModSummary[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState("default");
  const [search, setSearch] = useState("");
  const [sortNote, setSortNote] = useState(false);
  const [hidden, setHidden] = useState(0);
  const [blur, setBlur] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!game) return;
    getShowAdult().then((r) => r.ok && setBlur(Boolean(r.blur_adult))).catch(() => {});
    gbGetGame(game.appId, game.displayName)
      .then((r) => {
        if (!r.ok) {
          setError(r.error);
          setLinked(null);
          return;
        }
        setLinked(r.linked ?? null);
        setCandidates(r.candidates ?? []);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const load = async (p: number, append: boolean) => {
    if (!game || !linked) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(undefined);
    try {
      const r = await gbListMods(game.nexusDomain, game.appId, p, sort, search);
      if (mine !== seq.current) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setMods((prev) => (append ? [...prev, ...(r.mods ?? [])] : r.mods ?? []));
      setPage(p);
      setHasMore(Boolean(r.has_more));
      setTotal(r.total);
      setSortNote(Boolean(r.sort_fallback));
      setHidden((prev) => (append ? prev : 0) + (r.hidden ?? 0));
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  // Search is live, but only once typing pauses: GameBanana is asked once
  // per search, not once per letter.
  useEffect(() => {
    if (!linked) return;
    const t = setTimeout(() => load(1, false), search ? 450 : 0);
    return () => clearTimeout(t);
  }, [linked?.id, sort, search]);

  if (!game) {
    return (
      <div style={{ marginTop: "60px", padding: "20px" }}>
        Open a game's page first, then GameBanana from its store.
      </div>
    );
  }

  return (
    <Focusable
      onCancel={() => popOurPage()}
      style={{ marginTop: "40px", height: "calc(100% - 40px)", position: "relative" }}
    >
      <Scroller focusable={false} onButtonDown={handleTabButtons("store")} style={PAGE_SCROLLER}>
        <PageBackdrop
          src={`https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appId}/library_hero.jpg`}
          height={200}
          blur={false}
        />
        <div style={{ position: "relative", zIndex: 1 }}>
          <TabBar currentId="store" />
          <Focusable style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 0" }}>
            <div style={{ flexShrink: 1, minWidth: "160px", overflow: "hidden" }}>
              <h2 style={{ margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {game.displayName}
              </h2>
              <div style={{ fontSize: "13px", opacity: 0.7 }}>
                <span style={{ color: STEEL, fontWeight: 700 }}>GameBanana</span>
                {linked ? ` · ${linked.name}` : ""}
                {linked && total !== undefined ? ` · ${total.toLocaleString()} mods` : ""}
              </div>
            </div>
            <div style={{ flexGrow: 1 }} />
            {linked && (
              <>
                <div style={{ flexGrow: 1, maxWidth: "320px", minWidth: "160px" }}>
                  <TextField
                    label="Search"
                    value={search}
                    bShowClearAction={true}
                    onChange={(e) => setSearch(e?.target?.value ?? "")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLElement).blur();
                    }}
                  />
                </div>
                {!search && (
                  <div style={{ width: "190px", flexShrink: 0 }}>
                    <Dropdown rgOptions={SORTS} selectedOption={sort} onChange={(o) => setSort(o.data)} strDefaultLabel="Sort" />
                  </div>
                )}
                <DialogButton
                  style={{ width: "150px", minWidth: 0, flexShrink: 0, marginRight: "24px" }}
                  onClick={async () => {
                    await gbUnlinkGame(game.appId);
                    setMods([]);
                    setCandidates([]);
                    setLinked(null);
                  }}
                >
                  Change game
                </DialogButton>
              </>
            )}
          </Focusable>

          {error && <div style={{ padding: "12px 0", color: CRIMSON_TEXT }}>GameBanana: {error}</div>}
          {linked === undefined && !error && <div style={{ padding: "20px 0", opacity: 0.8 }}>Finding this game on GameBanana…</div>}
          {linked === null && (
            <LinkGame
              appId={game.appId}
              displayName={game.displayName}
              candidates={candidates}
              onLinked={(g) => {
                setError(undefined);
                setLinked(g);
              }}
            />
          )}
          {linked && (
            <>
              {sortNote && (
                <div style={{ fontSize: "12px", opacity: 0.7, marginBottom: "6px" }}>
                  GameBanana did not take that sort, so its default order is shown.
                </div>
              )}
              {hidden > 0 && (
                <div style={{ fontSize: "12px", opacity: 0.7, marginBottom: "6px" }}>
                  {hidden} adult mod{hidden === 1 ? "" : "s"} hidden, following your Nexus Mods adult-content setting.
                </div>
              )}
              <Focusable
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "10px" }}
              >
                {mods.map((m, i) => (
                  <GbTile
                    key={`${m.gb_id}-${i}`}
                    mod={m}
                    blur={blur}
                    onOpen={() => openGameBananaMod(game, m.gb_id)}
                  />
                ))}
              </Focusable>
              {loading && <div style={{ padding: "16px 0", opacity: 0.8 }}>Loading mods…</div>}
              {!loading && mods.length === 0 && !error && (
                <div style={{ padding: "16px 0", opacity: 0.8 }}>No mods found.</div>
              )}
              {hasMore && !loading && mods.length > 0 && (
                <Focusable style={{ margin: "14px auto 0", maxWidth: "320px" }}>
                  <DialogButton onClick={() => load(page + 1, true)}>Load more ({mods.length} shown)</DialogButton>
                </Focusable>
              )}
            </>
          )}
        </div>
      </Scroller>
    </Focusable>
  );
}
