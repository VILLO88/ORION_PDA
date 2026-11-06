// POST /api/refresh  — body: { refresh_token }
//
// The desktop app calls this when its access token is rejected (401). The
// refresh grant also needs the client_secret, so it must run here, not in the
// app. Returns the fresh token JSON as-is.
//
// SECURITY: never log the refresh/access tokens.

const { refresh } = require("../lib/notion");

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body; // Vercel pre-parsed
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }
  const body = await readJsonBody(req);
  const refreshToken = body && body.refresh_token;
  if (!refreshToken || typeof refreshToken !== "string") {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "missing refresh_token" }));
    return;
  }
  try {
    const token = await refresh(refreshToken);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(token));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "refresh_failed" }));
  }
};
