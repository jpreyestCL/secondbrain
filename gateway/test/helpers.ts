import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";

export async function listen(app: Hono): Promise<{ server: ServerType; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({ server, baseUrl: `http://127.0.0.1:${info.port}` });
    });
  });
}

export function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

/**
 * Runs the full OAuth 2.1 flow against the gateway for an existing user:
 * dynamic client registration -> email sign-in -> authorize (PKCE S256)
 * -> token exchange. Returns a bearer access token.
 */
export async function obtainAccessToken(
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const reg = await fetch(`${baseUrl}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "test-client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!reg.ok) throw new Error(`DCR failed: ${reg.status} ${await reg.text()}`);
  const client = (await reg.json()) as { client_id: string };

  const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authz = await fetch(`${baseUrl}/api/auth/mcp/authorize?${query}`, {
    redirect: "manual",
    headers: { cookie },
  });
  const location = authz.headers.get("location") ?? "";
  const code = location.startsWith("http") ? new URL(location).searchParams.get("code") : null;
  if (!code) throw new Error(`authorize did not return a code: ${authz.status} ${location}`);

  const tok = await fetch(`${baseUrl}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
    }),
  });
  if (!tok.ok) throw new Error(`token failed: ${tok.status} ${await tok.text()}`);
  const tokens = (await tok.json()) as { access_token?: string };
  if (!tokens.access_token) throw new Error("no access_token in token response");
  return tokens.access_token;
}
