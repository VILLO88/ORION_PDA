// GET /api/callback  — Notion redirects here after the user authorizes.
//
// Flow: validate state (carries the app's loopback {nonce, port}) → exchange
// code→token (with the client_secret, server-side) → 302 redirect the browser
// back to the desktop app's loopback server, passing the token over localhost.
//
// SECURITY:
//  - Never log `code` or the token.
//  - Only ever redirect to http://127.0.0.1:<port> (prevents open-redirect abuse).

const { exchangeCode } = require("../lib/notion");

function decodeState(state) {
  try {
    const json = Buffer.from(String(state), "base64url").toString("utf-8");
    const { nonce, port } = JSON.parse(json);
    return { nonce: String(nonce), port: Number(port) };
  } catch {
    return null;
  }
}

function isValidPort(p) {
  return Number.isInteger(p) && p >= 1024 && p <= 65535;
}

function isValidNonce(n) {
  return typeof n === "string" && /^[a-f0-9]{8,64}$/.test(n);
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const parsed = decodeState(state);
  if (!parsed || !isValidPort(parsed.port) || !isValidNonce(parsed.nonce)) {
    res.statusCode = 400;
    res.end("Invalid state");
    return;
  }

  const loopback = `http://127.0.0.1:${parsed.port}/cb`;

  if (oauthError) {
    res.statusCode = 302;
    res.setHeader(
      "Location",
      `${loopback}?error=${encodeURIComponent(oauthError)}&nonce=${parsed.nonce}`,
    );
    res.end();
    return;
  }

  if (!code) {
    res.statusCode = 400;
    res.end("Missing code");
    return;
  }

  try {
    const token = await exchangeCode(code);
    const payload = Buffer.from(JSON.stringify(token)).toString("base64");
    res.statusCode = 302;
    res.setHeader(
      "Location",
      `${loopback}?payload=${encodeURIComponent(payload)}&nonce=${parsed.nonce}`,
    );
    res.end();
  } catch (e) {
    res.statusCode = 302;
    res.setHeader(
      "Location",
      `${loopback}?error=exchange_failed&nonce=${parsed.nonce}`,
    );
    res.end();
  }
};
