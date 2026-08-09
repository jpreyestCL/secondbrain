import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { mcp } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import type { GatewayConfig } from "./env.js";

export type Auth = ReturnType<typeof createAuth>["auth"];

export interface CreateAuthOptions {
  /** Force-allow sign up regardless of config (used by the create-owner CLI). */
  forceAllowSignup?: boolean;
}

export function createAuth(config: GatewayConfig, opts: CreateAuthOptions = {}) {
  if (config.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");

  const allowSignup = opts.forceAllowSignup ?? config.allowSignup;

  const auth = betterAuth({
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    database: db,
    trustedOrigins: [config.baseUrl],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignup,
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
