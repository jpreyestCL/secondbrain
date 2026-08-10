import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { mcp } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import type { GatewayConfig } from "./env.js";

export type Auth = ReturnType<typeof createAuth>["auth"];

export interface CreateAuthOptions {
  /**
   * Kept for backwards compatibility (CLI scripts). Sign-up is now always
   * enabled at the Better Auth level; the PUBLIC endpoint
   * /api/auth/sign-up/* is gated in the HTTP layer (server.ts) according to
   * ALLOW_SIGNUP. This lets the code-gated /registro flow and the CLIs call
   * auth.api.signUpEmail() server-side even with ALLOW_SIGNUP=false.
   */
  forceAllowSignup?: boolean;
}

export function createAuth(config: GatewayConfig, _opts: CreateAuthOptions = {}) {
  if (config.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");

  // Google es OPCIONAL: solo se registra el proveedor social cuando AMBAS
  // credenciales están presentes. Si falta cualquiera, Google queda deshabilitado
  // por completo (sin crash, sin proveedor). El callback de Google
  // (/api/auth/callback/google) redirige a /post-google, la ruta que hace cumplir
  // el gate de invitación (ver server.ts) — Google NUNCA aprovisiona por su cuenta.
  const googleEnabled = Boolean(config.googleClientId && config.googleClientSecret);
  const socialProviders = googleEnabled
    ? {
        google: {
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
        },
      }
    : undefined;

  const auth = betterAuth({
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    database: db,
    trustedOrigins: [config.baseUrl],
    ...(socialProviders ? { socialProviders } : {}),
    emailAndPassword: {
      enabled: true,
      // El gate del endpoint público vive en server.ts (ver CreateAuthOptions).
      disableSignUp: false,
      requireEmailVerification: false,
      minPasswordLength: 10,
    },
    advanced: {
      // Behind cloudflared/tailscale the public origin is https even though
      // the local listener is http.
      useSecureCookies: config.baseUrl.startsWith("https://"),
    },
    plugins: [
      mcp({
        loginPage: "/login",
        // RFC 9728: the protected resource is the /mcp endpoint.
        resource: `${config.baseUrl}/mcp`,
        oidcConfig: {
          loginPage: "/login",
          // OAuth 2.1: PKCE obligatorio, solo S256.
          requirePKCE: true,
          allowPlainCodeChallengeMethod: false,
          accessTokenExpiresIn: 3600,
          refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        },
      }),
    ],
  });

  return { auth, db };
}

/** Create/upgrade the Better Auth schema in SQLite. */
export async function migrate(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
