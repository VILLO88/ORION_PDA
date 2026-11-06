/**
 * Configurazione Notion OAuth.
 *
 * `CLIENT_ID` e `BROKER_BASE_URL` sono PUBBLICI (è sicuro spedirli nell'app).
 * Il `client_secret` vive SOLO nel broker, mai qui. In dev si possono
 * sovrascrivere via env var senza ricompilare.
 *
 * ⚠️ Prima del rilascio:
 *  - sostituisci CLIENT_ID con il client_id della tua integrazione *public*
 *    (https://www.notion.so/my-integrations);
 *  - sostituisci BROKER_BASE_URL con l'URL HTTPS del broker deployato;
 *  - verifica NOTION_VERSION sulla doc ufficiale (https://developers.notion.com).
 */

/** client_id pubblico dell'integrazione Notion. */
export const CLIENT_ID =
  process.env.NOTION_OAUTH_CLIENT_ID ??
  "378d872b-594c-815c-b6fa-0037b3208c67";

/** Base URL HTTPS del broker OAuth (senza slash finale). */
export const BROKER_BASE_URL = (
  process.env.NOTION_BROKER_URL ??
  "https://orion-notion-broker.villanimatteo88.workers.dev"
).replace(/\/+$/, "");

/** redirect_uri registrato sull'integrazione Notion (deve combaciare). */
export const BROKER_CALLBACK_URL = `${BROKER_BASE_URL}/callback`;

/** Endpoint del broker per il refresh dell'access token. */
export const BROKER_REFRESH_URL = `${BROKER_BASE_URL}/refresh`;

/** Versione API Notion inviata in ogni richiesta dati. */
export const NOTION_VERSION = process.env.NOTION_API_VERSION ?? "2022-06-28";

export const AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";

export const NOTION_API_BASE = "https://api.notion.com/v1";

/** True se le costanti sono ancora i placeholder (broker/integrazione non configurati). */
export function isConfigured(): boolean {
  return (
    !CLIENT_ID.startsWith("REPLACE_WITH") &&
    !BROKER_BASE_URL.includes("REPLACE_WITH")
  );
}
