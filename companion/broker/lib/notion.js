// Shared Notion OAuth helpers for the broker.
// Holds NOTHING in memory between requests — fully stateless.
// The client_secret lives ONLY here (broker env), never in the desktop app.

const TOKEN_URL = "https://api.notion.com/v1/oauth/token";

function basicAuthHeader() {
  const id = process.env.NOTION_CLIENT_ID;
  const secret = process.env.NOTION_CLIENT_SECRET;
  if (!id || !secret) {
    // Fail loudly: never run "half configured".
    throw new Error("Missing NOTION_CLIENT_ID / NOTION_CLIENT_SECRET env vars");
  }
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

async function tokenRequest(body) {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/json",
      "Notion-Version": process.env.NOTION_VERSION || "2022-06-28",
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // Do NOT include code/token in the thrown message.
    const err = new Error(`Notion token endpoint ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return json;
}

// Exchange an authorization code for an access token.
async function exchangeCode(code) {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.NOTION_REDIRECT_URI,
  });
}

// Exchange a refresh token for a fresh access token.
async function refresh(refreshToken) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

module.exports = { exchangeCode, refresh };
