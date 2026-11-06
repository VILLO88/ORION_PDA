/**
 * Wrapper REST minimale sulle API dati di Notion (search/pages/blocks).
 *
 * Usa direttamente il Bearer access_token dell'utente (nessun client_secret).
 * Su 401 prova UNA volta a rinnovare il token tramite il broker e ritenta.
 *
 * Modello note → Notion:
 *  - una nota = una "child_page" sotto la pagina genitore;
 *  - una cartella = una child_page "contenitore" con dentro altre sottopagine;
 *  - il contenuto di una nota = blocchi `paragraph` (uno per riga). Nessun rich
 *    text: coerente col modello .txt del device.
 */

import { NOTION_API_BASE, NOTION_VERSION } from "./config";
import { refreshAccessToken } from "./auth";
import { getConnection } from "./tokenStore";

// Limiti Notion: rich_text content max 2000 char; max 100 blocchi per richiesta.
const MAX_TEXT = 2000;
const MAX_CHILDREN = 100;

interface RichText {
  plain_text?: string;
  text?: { content: string };
  type?: string;
}
interface Block {
  id: string;
  type: string;
  has_children?: boolean;
  child_page?: { title: string };
  [k: string]: unknown;
}
interface NotionPage {
  id: string;
  last_edited_time?: string;
  archived?: boolean;
  properties?: Record<string, { type?: string; title?: RichText[] }>;
  child_page?: { title: string };
}

async function notionFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const conn = await getConnection();
  if (!conn) throw new Error("Notion non collegato.");
  const resp = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (resp.status === 401 && retry) {
    await refreshAccessToken();
    return notionFetch<T>(path, init, false);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    // Messaggi noti tradotti in qualcosa di comprensibile per l'utente finale.
    if (/cannot have content/i.test(body)) {
      throw new Error(
        "La pagina scelta non può contenere note (è un profilo utente o un " +
          "database, non una pagina normale). In Notion crea una pagina vuota, " +
          'condividila con l\'integrazione e selezionala come "pagina genitore".',
      );
    }
    throw new Error(`Notion API ${resp.status}: ${body.slice(0, 300)}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

// ---------------------------------------------------------------------------
//  Titoli / conversione testo
// ---------------------------------------------------------------------------

function titleOfPage(page: NotionPage): string {
  if (page.child_page?.title) return page.child_page.title;
  const props = page.properties ?? {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p?.type === "title" && Array.isArray(p.title)) {
      return p.title.map((t) => t.plain_text ?? t.text?.content ?? "").join("");
    }
  }
  return "Untitled";
}

function chunkString(s: string, n: number): string[] {
  if (s.length <= n) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

/** Testo → blocchi paragraph (uno per riga, chunked a 2000 char). */
function textToBlocks(text: string): object[] {
  const lines = text.split("\n");
  return lines.map((line) => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text:
        line.length === 0
          ? []
          : chunkString(line, MAX_TEXT).map((c) => ({
              type: "text",
              text: { content: c },
            })),
    },
  }));
}

function blockToText(block: Block): string | null {
  // Leggiamo solo i blocchi testuali che noi stessi scriviamo.
  const rt = (block[block.type] as { rich_text?: RichText[] } | undefined)
    ?.rich_text;
  if (!Array.isArray(rt)) return null;
  return rt.map((t) => t.plain_text ?? t.text?.content ?? "").join("");
}

// ---------------------------------------------------------------------------
//  Operazioni
// ---------------------------------------------------------------------------

export interface PageRef {
  id: string;
  title: string;
}

/** Pagine accessibili all'integrazione (per scegliere la pagina genitore). */
export async function searchPages(): Promise<PageRef[]> {
  const out: PageRef[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filter: { value: "page", property: "object" },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const r = await notionFetch<{
      results: NotionPage[];
      has_more: boolean;
      next_cursor: string | null;
    }>("/search", { method: "POST", body: JSON.stringify(body) });
    for (const p of r.results) {
      if (p.archived) continue;
      out.push({ id: p.id, title: titleOfPage(p) });
    }
    cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
  } while (cursor);
  return out;
}

async function listChildren(blockId: string): Promise<Block[]> {
  const out: Block[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const r = await notionFetch<{
      results: Block[];
      has_more: boolean;
      next_cursor: string | null;
    }>(`/blocks/${blockId}/children?${qs.toString()}`);
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
  } while (cursor);
  return out;
}

/** Sottopagine dirette (child_page) di una pagina. */
export async function listChildPages(parentId: string): Promise<PageRef[]> {
  const blocks = await listChildren(parentId);
  return blocks
    .filter((b) => b.type === "child_page")
    .map((b) => ({ id: b.id, title: b.child_page?.title ?? "Untitled" }));
}

/** Testo ricostruito dai blocchi paragraph di una pagina. */
export async function getPagePlainText(pageId: string): Promise<string> {
  const blocks = await listChildren(pageId);
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type === "child_page") continue; // sottopagina, non contenuto
    const t = blockToText(b);
    if (t !== null) lines.push(t);
  }
  return lines.join("\n");
}

/** last_edited_time della pagina in ms (0 se assente). */
export async function getPageLastEditedMs(pageId: string): Promise<number> {
  const p = await notionFetch<NotionPage>(`/pages/${pageId}`);
  return p.last_edited_time ? Date.parse(p.last_edited_time) || 0 : 0;
}

async function appendChildren(parentId: string, children: object[]): Promise<void> {
  for (let i = 0; i < children.length; i += MAX_CHILDREN) {
    const slice = children.slice(i, i + MAX_CHILDREN);
    await notionFetch(`/blocks/${parentId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: slice }),
    });
  }
}

/** Crea una sottopagina con titolo + contenuto testuale. Ritorna l'id. */
export async function createNotePage(
  parentId: string,
  title: string,
  text: string,
): Promise<string> {
  const r = await notionFetch<{ id: string }>("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: parentId },
      properties: {
        title: { title: [{ type: "text", text: { content: title } }] },
      },
    }),
  });
  const blocks = textToBlocks(text);
  if (blocks.length) await appendChildren(r.id, blocks);
  return r.id;
}

/** Crea (o riusa) una sottopagina "contenitore" (cartella). Ritorna l'id. */
export async function ensureFolderPage(
  parentId: string,
  name: string,
): Promise<string> {
  const existing = await listChildPages(parentId);
  const hit = existing.find((p) => p.title === name);
  if (hit) return hit.id;
  const r = await notionFetch<{ id: string }>("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: parentId },
      properties: {
        title: { title: [{ type: "text", text: { content: name } }] },
      },
    }),
  });
  return r.id;
}

/** Sostituisce il contenuto testuale di una pagina (preserva le sottopagine). */
export async function replacePageContent(
  pageId: string,
  text: string,
): Promise<void> {
  const blocks = await listChildren(pageId);
  for (const b of blocks) {
    if (b.type === "child_page") continue; // NON cancellare sottopagine
    await notionFetch(`/blocks/${b.id}`, { method: "DELETE" });
  }
  const newBlocks = textToBlocks(text);
  if (newBlocks.length) await appendChildren(pageId, newBlocks);
}

/** Archivia (cestina) una pagina. */
export async function archivePage(pageId: string): Promise<void> {
  await notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
}
