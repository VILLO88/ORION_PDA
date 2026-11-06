/**
 * Notion OAuth lato app (desktop, senza backend proprio).
 *
 * Flusso "loopback": l'app apre un server effimero su 127.0.0.1:<porta random>
 * e lo usa come destinazione finale del redirect. Il browser di sistema fa il
 * login Notion; Notion redirige al BROKER (che custodisce il client_secret e
 * scambia code→token); il broker redirige a localhost passando il token. Così
 * il token viaggia solo su localhost e il secret non tocca mai l'app.
 *
 * Vedi anche `config.ts` (costanti pubbliche) e `tokenStore.ts` (cifratura).
 */

import { shell } from "electron";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import type {
  NotionConnectResponse,
  NotionStatusResponse,
} from "../../../shared/ipc-types";
import {
  AUTHORIZE_URL,
  BROKER_CALLBACK_URL,
  BROKER_REFRESH_URL,
  CLIENT_ID,
  isConfigured,
} from "./config";
import {
  clearConnection,
  getConnection,
  patchConnection,
  saveConnection,
  type NotionConnection,
} from "./tokenStore";

const CONNECT_TIMEOUT_MS = 3 * 60 * 1000;

/** Token JSON restituito da Notion (campi che ci interessano). */
interface NotionTokenPayload {
  access_token: string;
  refresh_token?: string;
  workspace_id: string;
  workspace_name?: string;
  bot_id?: string;
}

function html(body: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#161f2c;color:#e5e7eb;display:flex;height:100vh;align-items:center;justify-content:center;margin:0"><div style="text-align:center"><h2>${body}</h2><p style="color:#94a3b8">Puoi chiudere questa scheda e tornare a Orion Companion.</p></div></body>`;
}

function connFromPayload(t: NotionTokenPayload): NotionConnection {
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    workspaceId: t.workspace_id,
    workspaceName: t.workspace_name ?? "Notion workspace",
    botId: t.bot_id,
  };
}

export async function connect(): Promise<NotionConnectResponse> {
  if (!isConfigured()) {
    throw new Error(
      "Notion non configurato: imposta client_id e URL del broker in src/main/ipc/notion/config.ts (vedi broker/README.md).",
    );
  }

  const nonce = randomBytes(16).toString("hex");

  return await new Promise<NotionConnectResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        if (reqUrl.pathname !== "/cb") {
          res.writeHead(404).end();
          return;
        }
        const err = reqUrl.searchParams.get("error");
        if (err) {
          res.writeHead(200, { "Content-Type": "text/html" }).end(
            html("Autorizzazione annullata."),
          );
          finish(() => reject(new Error(`Notion: ${err}`)));
          return;
        }
        if (reqUrl.searchParams.get("nonce") !== nonce) {
          res.writeHead(400, { "Content-Type": "text/html" }).end(
            html("Richiesta non valida."),
          );
          // non chiudere: potrebbe essere una richiesta spuria
          return;
        }
        const payloadB64 = reqUrl.searchParams.get("payload");
        if (!payloadB64) {
          res.writeHead(400, { "Content-Type": "text/html" }).end(
            html("Token mancante."),
          );
          finish(() => reject(new Error("Notion: payload mancante dal broker.")));
          return;
        }
        const token = JSON.parse(
          Buffer.from(payloadB64, "base64").toString("utf-8"),
        ) as NotionTokenPayload;

        res.writeHead(200, { "Content-Type": "text/html" }).end(
          html("✓ Notion collegato!"),
        );

        const conn = connFromPayload(token);
        void saveConnection(conn)
          .then(() =>
            finish(() =>
              resolve({ connected: true, workspaceName: conn.workspaceName }),
            ),
          )
          .catch((e) => finish(() => reject(e)));
      } catch (e) {
        try {
          res.writeHead(500).end();
        } catch {
          /* ignore */
        }
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });

    const timer = setTimeout(
      () => finish(() => reject(new Error("Timeout: login Notion non completato."))),
      CONNECT_TIMEOUT_MS,
    );

    server.on("error", (e) => finish(() => reject(e)));

    // Porta random libera su loopback.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (!port) {
        finish(() => reject(new Error("Impossibile aprire il server loopback.")));
        return;
      }
      const state = Buffer.from(JSON.stringify({ nonce, port })).toString(
        "base64url",
      );
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", CLIENT_ID);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("owner", "user");
      url.searchParams.set("redirect_uri", BROKER_CALLBACK_URL);
      url.searchParams.set("state", state);
      void shell.openExternal(url.toString());
    });
  });
}

export async function status(): Promise<NotionStatusResponse> {
  const c = await getConnection();
  if (!c) return { connected: false };
  return {
    connected: true,
    workspaceName: c.workspaceName,
    parentPageId: c.parentPageId,
    parentPageTitle: c.parentPageTitle,
  };
}

export async function disconnect(): Promise<void> {
  await clearConnection();
}

/**
 * Rinnova l'access token tramite il broker (che ha il client_secret).
 * Ritorna il nuovo access token. Lancia se non c'è refresh token o fallisce.
 */
export async function refreshAccessToken(): Promise<string> {
  const c = await getConnection();
  if (!c?.refreshToken) {
    throw new Error("Token Notion scaduto: ricollega il tuo account.");
  }
  const resp = await fetch(BROKER_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: c.refreshToken }),
  });
  if (!resp.ok) {
    throw new Error("Refresh del token Notion fallito: ricollega l'account.");
  }
  const token = (await resp.json()) as NotionTokenPayload;
  const next = await patchConnection({
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? c.refreshToken,
  });
  return next.accessToken;
}
