// Orion <-> Notion OAuth broker — Cloudflare Worker.
//
// Stateless. Holds the Notion client_secret (Worker secret) so the distributed
// desktop app never has to. Two routes:
//   GET  /callback  — Notion redirect; exchange code->token; 302 to app loopback
//   POST /refresh   — body { refresh_token } -> fresh token JSON
//
// Uses only Web APIs (no Node Buffer), so no nodejs_compat flag needed.
// SECURITY: never log `code` or tokens; only ever redirect to 127.0.0.1.

const TOKEN_URL = "https://api.notion.com/v1/oauth/token";

// ---- base64 helpers (UTF-8 safe, Web-only) --------------------------------

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin); // standard base64 (the desktop app decodes with Buffer "base64")
}

function b64urlDecodeToStr(s) {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---- Notion token endpoint -------------------------------------------------

function basicAuth(env) {
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    throw new Error("Missing NOTION_CLIENT_ID / NOTION_CLIENT_SECRET");
  }
  return "Basic " + btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
}

async function tokenRequest(env, body) {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(env),
      "Content-Type": "application/json",
      "Notion-Version": env.NOTION_VERSION || "2022-06-28",
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Notion token endpoint ${resp.status}`);
  return json;
}

// ---- state validation ------------------------------------------------------

function decodeState(state) {
  try {
    const { nonce, port } = JSON.parse(b64urlDecodeToStr(state));
    return { nonce: String(nonce), port: Number(port) };
  } catch {
    return null;
  }
}
const validPort = (p) => Number.isInteger(p) && p >= 1024 && p <= 65535;
const validNonce = (n) => typeof n === "string" && /^[a-f0-9]{8,64}$/.test(n);

const redirect = (location) =>
  new Response(null, { status: 302, headers: { Location: location } });
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ---- routes ----------------------------------------------------------------

async function handleCallback(url, env) {
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  const parsed = decodeState(url.searchParams.get("state"));

  if (!parsed || !validPort(parsed.port) || !validNonce(parsed.nonce)) {
    return new Response("Invalid state", { status: 400 });
  }
  const loopback = `http://127.0.0.1:${parsed.port}/cb`;

  if (oauthError) {
    return redirect(
      `${loopback}?error=${encodeURIComponent(oauthError)}&nonce=${parsed.nonce}`,
    );
  }
  if (!code) return new Response("Missing code", { status: 400 });

  try {
    const token = await tokenRequest(env, {
      grant_type: "authorization_code",
      code,
      redirect_uri: env.NOTION_REDIRECT_URI,
    });
    const payload = encodeURIComponent(b64encodeUtf8(JSON.stringify(token)));
    return redirect(`${loopback}?payload=${payload}&nonce=${parsed.nonce}`);
  } catch {
    return redirect(`${loopback}?error=exchange_failed&nonce=${parsed.nonce}`);
  }
}

async function handleRefresh(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* empty */
  }
  const refreshToken = body && body.refresh_token;
  if (!refreshToken || typeof refreshToken !== "string") {
    return json({ error: "missing refresh_token" }, 400);
  }
  try {
    const token = await tokenRequest(env, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return json(token);
  } catch {
    return json({ error: "refresh_failed" }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/callback") return handleCallback(url, env);
    if (url.pathname === "/refresh") return handleRefresh(request, env);
    return new Response("Not found", { status: 404 });
  },
};
