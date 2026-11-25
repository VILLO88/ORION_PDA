/**
 * App Store: the account and the HTTP client.
 *
 * Login with GitHub through the store's server (a Cloudflare Worker), the same loopback
 * flow as Notion (`../ipc/notion/auth.ts`): an ephemeral server on
 * 127.0.0.1:<random port>, the system browser for GitHub, and the Worker
 * redirecting back to that port with a session token of ITS OWN. The GitHub
 * token never reaches the app.
 *
 * The session token is kept encrypted with `safeStorage` (Keychain on
 * macOS), like the Notion connection.
 */
import { app, safeStorage, shell } from "electron";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StoreAccount } from "../../shared/ipc-types";

/** The Worker's URL, no trailing slash. `ORION_STORE_URL` for another
 *  instance (a test deploy, `wrangler dev`). */
export const STORE_URL = (
  process.env.ORION_STORE_URL ?? "https://orion-store.villanimatteo88.workers.dev"
).replace(/\/+$/, "");

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

interface Session extends StoreAccount {
  token: string;
}

function sessionPath(): string {
  return join(app.getPath("userData"), "store", "session.json");
}

let cache: Session | null | undefined;

async function loadSession(): Promise<Session | null> {
  if (cache !== undefined) return cache;
  cache = null;
  const p = sessionPath();
  if (existsSync(p) && safeStorage.isEncryptionAvailable()) {
    try {
      cache = JSON.parse(safeStorage.decryptString(Buffer.from(await readFile(p, "utf-8"), "base64")));
    } catch {
      cache = null; // damaged, or the keychain key changed: signed out
    }
  }
  return cache ?? null;
}

async function saveSession(s: Session): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("No secure storage on this system: cannot keep the store login.");
  }
  const p = sessionPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, safeStorage.encryptString(JSON.stringify(s)).toString("base64"), "utf-8");
  cache = s;
}

async function clearSession(): Promise<void> {
  cache = null;
  await rm(sessionPath(), { force: true });
}

// ---------------------------------------------------------------------------
//  HTTP
// ---------------------------------------------------------------------------

export class StoreHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** One call to the store. `auth`: send the session token if there is one.
 *  A 401 with a token means the session is gone (expired, banned, signed
 *  out elsewhere): it is dropped here, so the page shows "Sign in". */
export async function call<T>(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; raw?: boolean } = {},
): Promise<T> {
  const s = opts.auth === false ? null : await loadSession();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (s) headers.Authorization = `Bearer ${s.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let r: Response;
  try {
    r = await fetch(`${STORE_URL}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new Error("The App Store cannot be reached: check the internet connection.");
  }
  if (r.status === 401 && s) await clearSession();
  if (!r.ok) {
    let msg = `App Store: HTTP ${r.status}`;
    try {
      const e = (await r.json()) as { error?: string };
      if (e.error) msg = e.error;
    } catch {
      /* not JSON */
    }
    if (r.status === 401 && s) msg = "Your store session has expired: sign in again.";
    throw new StoreHttpError(r.status, msg);
  }
  if (opts.raw) return r as unknown as T;
  return (await r.json()) as T;
}

// ---------------------------------------------------------------------------
//  Account
// ---------------------------------------------------------------------------

export async function account(): Promise<StoreAccount | null> {
  const s = await loadSession();
  if (!s) return null;
  try {
    const me = await call<StoreAccount>("GET", "/v1/me");
    const next = { ...s, ...me };
    if (next.login !== s.login || next.admin !== s.admin || next.avatar !== s.avatar) await saveSession(next);
    return me;
  } catch {
    /* Offline: the cached account, so the page does not look signed out.
       A real 401 has already cleared the session in call(). */
    const still = await loadSession();
    return still ? { login: still.login, avatar: still.avatar, admin: still.admin } : null;
  }
}

function pagina(msg: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#161f2c;color:#e5e7eb;display:flex;height:100vh;align-items:center;justify-content:center;margin:0"><div style="text-align:center"><h2>${msg}</h2><p style="color:#94a3b8">You can close this tab and go back to Orion Companion.</p></div></body>`;
}

export async function signIn(): Promise<StoreAccount> {
  const nonce = randomBytes(16).toString("hex");
  const token = await new Promise<string>((resolve, reject) => {
    let finito = false;
    const fine = (f: () => void) => {
      if (finito) return;
      finito = true;
      clearTimeout(timer);
      server.close();
      f();
    };
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/cb") {
        res.writeHead(404).end();
        return;
      }
      /* A request without our nonce is not the answer we wait for: it does
         not end the wait. */
      if (u.searchParams.get("nonce") !== nonce) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(pagina("Invalid request."));
        return;
      }
      const err = u.searchParams.get("error");
      const t = u.searchParams.get("token");
      if (err || !t) {
        res.writeHead(200, { "Content-Type": "text/html" }).end(pagina("Sign-in not completed."));
        const why = err === "banned" ? "this account is banned from the store" : err ?? "no token";
        fine(() => reject(new Error(`GitHub sign-in failed: ${why}.`)));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(pagina("✓ Signed in to the Orion App Store"));
      fine(() => resolve(t));
    });
    const timer = setTimeout(
      () => fine(() => reject(new Error("Sign-in timed out: the GitHub page was not completed."))),
      LOGIN_TIMEOUT_MS,
    );
    server.on("error", (e) => fine(() => reject(e)));
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      const port = typeof a === "object" && a ? a.port : 0;
      if (!port) {
        fine(() => reject(new Error("Cannot open the local sign-in port.")));
        return;
      }
      void shell.openExternal(`${STORE_URL}/auth/start?port=${port}&nonce=${nonce}`);
    });
  });

  /* Who it is: asked with the new token before saving anything. */
  cache = { token, login: "", avatar: null, admin: false };
  try {
    const me = await call<StoreAccount>("GET", "/v1/me");
    await saveSession({ token, ...me });
    return me;
  } catch (e) {
    cache = undefined;
    throw e;
  }
}

export async function signOut(): Promise<void> {
  try {
    await call("POST", "/v1/logout");
  } catch {
    /* offline: the local session goes anyway */
  }
  await clearSession();
}
