import {
  Action,
  ActionPanel,
  closeMainWindow,
  environment,
  getPreferenceValues,
  Icon,
  LaunchProps,
  List,
  showHUD,
} from "@raycast/api";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { useEffect, useMemo, useState } from "react";
import { addLittleWindowId, CHROME, exec, osascript, windowIds } from "./chrome";

const CHROME_DIR = join(homedir(), "Library/Application Support/Google/Chrome");

export function toUrl(input: string): string {
  const q = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q) || /^(about|chrome|data|file|mailto):/i.test(q)) return q;
  if (/\s/.test(q)) return googleSearch(q);
  if (/^(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.(localhost|test))(:\d+)?(\/.*)?$/i.test(q)) return `http://${q}`;
  if (/^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(q) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(q)) {
    return `https://${q}`;
  }
  return googleSearch(q);
}

function googleSearch(q: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

async function isChromeRunning(): Promise<boolean> {
  return (await osascript(`application "${CHROME}" is running`)) === "true";
}

async function resizeNewWindow(before: Set<string>, width: number, height: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 75));
    const id = (await windowIds()).find((w) => !before.has(w));
    if (!id) continue;
    await addLittleWindowId(id);
    await osascript(`tell application "${CHROME}"
      set w to window id ${id}
      set b to bounds of w
      set bounds of w to {item 1 of b, item 2 of b, (item 1 of b) + ${width}, (item 2 of b) + ${height}}
      set index of w to 1
      activate
    end tell`);
    return;
  }
}

async function openLittleChrome(url: string): Promise<void> {
  const prefs = getPreferenceValues<Preferences>();
  const width = parseInt(prefs.width ?? "", 10) || 900;
  const height = parseInt(prefs.height ?? "", 10) || 700;

  await closeMainWindow({ clearRootSearch: true });
  try {
    const before = new Set((await isChromeRunning()) ? await windowIds() : []);
    await exec("open", ["-na", CHROME, "--args", `--app=${url}`, `--window-size=${width},${height}`]);
    await resizeNewWindow(before, width, height);
  } catch (e) {
    await showHUD(`Little Chrome failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type HistoryItem = { url: string; title: string; favicon?: string };

const FAVICON_DIR = join(environment.supportPath, "favicons");

// Chrome locks its History/Favicons DBs while running, so query snapshot copies.
function snapshotHistory(): string | undefined {
  try {
    let profile = "Default";
    try {
      profile = JSON.parse(readFileSync(join(CHROME_DIR, "Local State"), "utf8")).profile?.last_used || profile;
    } catch {
      // keep Default
    }
    const dest = join(tmpdir(), "little-chrome-history.sqlite");
    copyFileSync(join(CHROME_DIR, profile, "History"), dest);
    try {
      copyFileSync(join(CHROME_DIR, profile, "Favicons"), join(tmpdir(), "little-chrome-favicons.sqlite"));
    } catch {
      // history without favicons
    }
    return dest;
  } catch {
    return undefined;
  }
}

async function sqlite<T>(db: string, sql: string): Promise<T[]> {
  const favicons = join(tmpdir(), "little-chrome-favicons.sqlite");
  const attach = existsSync(favicons) ? ["-cmd", `ATTACH '${favicons.replace(/'/g, "''")}' AS f`] : [];
  const { stdout } = await exec("sqlite3", [...attach, "-json", db, sql], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

async function searchHistory(db: string, text: string): Promise<HistoryItem[]> {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const escape = (w: string) => w.replace(/'/g, "''").replace(/[\\%_]/g, "\\$&");
  const where = words.map((w) => {
    const like = `'%${escape(w)}%'`;
    return `(url LIKE ${like} ESCAPE '\\' OR title LIKE ${like} ESCAPE '\\')`;
  });
  const filter = `hidden = 0 ${where.map((w) => `AND ${w}`).join(" ")}`;
  // Frecency: visits (typed ones weigh double) decayed by days since the last visit,
  // tripled when the first word matches the start of the host (e.g. "git" -> github.com).
  const hostMatch = words.length
    ? `CASE WHEN ${["https://", "http://", "https://www.", "http://www."]
        .map((p) => `url LIKE '${p}${escape(words[0])}%' ESCAPE '\\'`)
        .join(" OR ")} THEN 3 ELSE 1 END`
    : "1";
  const days = `((strftime('%s', 'now') + 11644473600) * 1000000 - last_visit_time) / 86400000000.0`;
  const recency = `CASE WHEN ${days} < 4 THEN 1.0 WHEN ${days} < 14 THEN 0.7 WHEN ${days} < 31 THEN 0.5
    WHEN ${days} < 90 THEN 0.3 ELSE 0.1 END`;
  const order = `ORDER BY (visit_count + 2 * typed_count) * ${recency} * ${hostMatch} DESC, last_visit_time DESC LIMIT 50`;
  try {
    // Largest favicon bitmap per page; files are cached by bitmap id + update time.
    const rows = await sqlite<HistoryItem & { bitmap: string | null }>(
      db,
      `SELECT url, title, (SELECT b.id || '-' || b.last_updated FROM f.icon_mapping m
         JOIN f.favicon_bitmaps b ON b.icon_id = m.icon_id
         WHERE m.page_url = urls.url ORDER BY b.width DESC LIMIT 1) AS bitmap
       FROM urls WHERE ${filter} ${order}`,
    );
    const missing = [...new Set(rows.map((r) => r.bitmap).filter((b): b is string => !!b))].filter(
      (b) => !existsSync(join(FAVICON_DIR, `${b}.png`)),
    );
    if (missing.length) {
      mkdirSync(FAVICON_DIR, { recursive: true });
      const ids = missing.map((b) => parseInt(b, 10)).join(",");
      const images = await sqlite<{ key: string; data: string }>(
        db,
        `SELECT id || '-' || last_updated AS key, hex(image_data) AS data FROM f.favicon_bitmaps WHERE id IN (${ids})`,
      );
      for (const { key, data } of images) writeFileSync(join(FAVICON_DIR, `${key}.png`), Buffer.from(data, "hex"));
    }
    return rows.map(({ url, title, bitmap }) => ({
      url,
      title,
      favicon:
        bitmap && existsSync(join(FAVICON_DIR, `${bitmap}.png`)) ? join(FAVICON_DIR, `${bitmap}.png`) : undefined,
    }));
  } catch {
    return sqlite<HistoryItem>(db, `SELECT url, title FROM urls WHERE ${filter} ${order}`);
  }
}

export default function Command(props: LaunchProps) {
  const [searchText, setSearchText] = useState(props.fallbackText ?? "");
  const [items, setItems] = useState<HistoryItem[]>([]);
  // Raycast resets the selection to the first row on every search change, so give each
  // result set fresh ids to make selectedItemId change and re-select the top history row.
  const [generation, setGeneration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const db = useMemo(snapshotHistory, []);

  useEffect(() => {
    if (!db) return setIsLoading(false);
    let cancelled = false;
    setIsLoading(true);
    // Debounce the query only; the typed row follows searchText immediately and stays selected
    // until fresh results arrive, so Enter while typing opens what was typed.
    const timer = setTimeout(() => {
      searchHistory(db, searchText)
        .then((r) => {
          if (cancelled) return;
          setItems(r);
          setGeneration((g) => g + 1);
        })
        .catch(() => !cancelled && setItems([]))
        .finally(() => !cancelled && setIsLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [db, searchText]);

  const typed = searchText.trim();

  return (
    <List
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="URL or search"
      isLoading={isLoading}
      filtering={false}
      selectedItemId={items[0] ? `${generation}:${items[0].url}` : undefined}
    >
      {typed && (
        <List.Item
          id="typed"
          icon={Icon.Globe}
          title={typed}
          subtitle={toUrl(typed)}
          actions={
            <ActionPanel>
              <Action
                title="Open in Little Chrome"
                icon={Icon.Window}
                onAction={() => openLittleChrome(toUrl(typed))}
              />
            </ActionPanel>
          }
        />
      )}
      <List.Section title="History">
        {items.map((item) => (
          <List.Item
            key={`${generation}:${item.url}`}
            id={`${generation}:${item.url}`}
            icon={item.favicon ? { source: item.favicon, fallback: Icon.Clock } : Icon.Clock}
            title={item.title || item.url}
            subtitle={item.title ? item.url : undefined}
            actions={
              <ActionPanel>
                <Action title="Open in Little Chrome" icon={Icon.Window} onAction={() => openLittleChrome(item.url)} />
                <Action.CopyToClipboard title="Copy URL" content={item.url} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
