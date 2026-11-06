/**
 * Store cifrato della connessione Notion dell'utente.
 *
 * Il token resta SOLO sul Mac dell'utente, cifrato con `safeStorage` (che usa
 * il portachiavi del SO: Keychain su macOS, DPAPI su Windows, libsecret su
 * Linux). Su disco salviamo solo il ciphertext in base64 — mai il token in
 * chiaro. Nessun DB, nessun token lato server.
 */

import { app, safeStorage } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface NotionConnection {
  accessToken: string;
  refreshToken?: string;
  workspaceId: string;
  workspaceName: string;
  botId?: string;
  /** Pagina genitore scelta dove vivono le note. */
  parentPageId?: string;
  parentPageTitle?: string;
}

function storePath(): string {
  return join(app.getPath("userData"), "notion", "connection.json");
}

let cache: NotionConnection | null | undefined;

export async function getConnection(): Promise<NotionConnection | null> {
  if (cache !== undefined) return cache;
  const p = storePath();
  if (!existsSync(p)) {
    cache = null;
    return null;
  }
  try {
    const b64 = await readFile(p, "utf-8");
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Cifratura non disponibile su questo sistema.");
    }
    const json = safeStorage.decryptString(Buffer.from(b64, "base64"));
    cache = JSON.parse(json) as NotionConnection;
    return cache;
  } catch {
    // file corrotto o chiave cambiata: tratta come non connesso
    cache = null;
    return null;
  }
}

export async function saveConnection(conn: NotionConnection): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Cifratura non disponibile: impossibile salvare il token Notion in sicurezza.",
    );
  }
  const p = storePath();
  await mkdir(dirname(p), { recursive: true });
  const enc = safeStorage.encryptString(JSON.stringify(conn));
  await writeFile(p, enc.toString("base64"), "utf-8");
  cache = conn;
}

/** Aggiorna solo alcuni campi della connessione (es. dopo un refresh). */
export async function patchConnection(
  patch: Partial<NotionConnection>,
): Promise<NotionConnection> {
  const cur = await getConnection();
  if (!cur) throw new Error("Nessuna connessione Notion da aggiornare.");
  const next = { ...cur, ...patch };
  await saveConnection(next);
  return next;
}

export async function clearConnection(): Promise<void> {
  const p = storePath();
  cache = null;
  if (existsSync(p)) await rm(p, { force: true });
}
