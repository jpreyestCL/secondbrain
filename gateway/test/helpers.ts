import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { MailError, type MailMessage, type Mailer } from "../src/mailer.js";
import type { Provisioner } from "../src/provision.js";

/** Mailer de mentira: guarda lo enviado y puede fingir fallos de Resend. */
export interface FakeMailer extends Mailer {
  readonly sent: MailMessage[];
  /** Cuando es true, cada envío lanza como si Resend devolviera 403. */
  fail: boolean;
  last(): MailMessage | undefined;
  clear(): void;
}

export function fakeMailer(): FakeMailer {
  const sent: MailMessage[] = [];
  return {
    enabled: true,
    debug: false,
    from: "Second Brain <test@rlz.cl>",
    sent,
    fail: false,
    last: () => sent[sent.length - 1],
    clear: () => {
      sent.length = 0;
    },
    async send(message: MailMessage) {
      if ((this as FakeMailer).fail) {
        throw new MailError("resend_error", "Resend respondió 403: dominio sin verificar", 403);
      }
      sent.push(message);
      return { id: `fake_${sent.length}`, debug: false };
    },
  };
}

/** Aprovisionador de mentira: no ejecuta nada, solo devuelve un upstream. */
export function fakeProvisioner(upstream = "http://127.0.0.1:9099/mcp"): Provisioner {
  let n = 0;
  return {
    async provision(email: string) {
      n += 1;
      return { slug: `t${n}-${email.split("@")[0]}`, port: 9000 + n, upstreamUrl: upstream };
    },
  };
}

/** Extrae la primera URL http(s) del texto plano de un correo. */
export function urlInMail(text: string): string {
  const match = /https?:\/\/\S+/.exec(text);
  if (!match) throw new Error(`el correo no trae ninguna URL:\n${text}`);
  return match[0];
}

/** Reescribe una URL del correo para apuntarla al servidor de pruebas. */
export function onTestServer(url: string, baseUrl: string): string {
  const original = new URL(url);
  return `${baseUrl}${original.pathname}${original.search}`;
}

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

/** Extrae todos los <input type="hidden"> de una página del gateway. */
export function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /<input[^>]*type="hidden"[^>]*>/g;
  for (const tag of html.match(re) ?? []) {
    const name = /name="([^"]+)"/.exec(tag)?.[1];
    const value = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
    if (name) fields[name] = decodeEntities(value);
  }
  return fields;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Aprueba la pantalla de consentimiento del gateway y devuelve la respuesta de
 * /authorize que sigue (la que trae el `code`).
 */
export async function approveConsent(
  baseUrl: string,
  cookie: string,
  html: string,
  decision: "autorizar" | "cancelar" = "autorizar",
): Promise<Response> {
  const body = new URLSearchParams({ ...hiddenFields(html), decision });
  const res = await fetch(`${baseUrl}/consentimiento`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin: baseUrl,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const location = res.headers.get("location") ?? "";
  if (decision === "cancelar" || !location.startsWith("/api/auth/mcp/authorize")) {
    return res;
  }
  return fetch(`${baseUrl}${location}`, { redirect: "manual", headers: { cookie } });
}

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
  let authz = await fetch(`${baseUrl}/api/auth/mcp/authorize?${query}`, {
    redirect: "manual",
    headers: { cookie },
  });
  // El gateway interpone SU pantalla de consentimiento la primera vez que este
  // usuario ve este client_id: se aprueba como lo haría la persona.
  if (authz.status === 200) {
    const html = await authz.text();
    authz = await approveConsent(baseUrl, cookie, html);
  }
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
