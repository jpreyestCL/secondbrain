import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from src/ (tsx) and dist/ (compiled): gateway root is one level up.
export const gatewayRoot = path.resolve(here, "..");

export interface GatewayConfig {
  /** Public base URL of the gateway (tunnel URL in production). */
  baseUrl: string;
  /** Secret used by Better Auth to sign cookies/tokens. */
  authSecret: string;
  /**
   * Convenience default used ONLY by `npm run create-owner` to seed the first
   * owner's tenant mapping. The /mcp route never falls back to it.
   */
  graphitiMcpUrl: string;
  /** Path to tenants.json (user -> upstream MCP URL registry). */
  tenantsFile: string;
  port: number;
  host: string;
  /** When false (default) registration is disabled; owner is created via CLI. */
  allowSignup: boolean;
  /** Absolute path to the SQLite database file, or ":memory:". */
  dbPath: string;
}

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const port = Number(process.env.PORT ?? 8787);
  const baseUrl = (process.env.BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const authSecret = process.env.AUTH_SECRET ?? "";
  return {
    baseUrl,
    authSecret,
    graphitiMcpUrl: process.env.GRAPHITI_MCP_URL ?? "http://127.0.0.1:8020/mcp",
    tenantsFile: process.env.TENANTS_FILE ?? path.join(gatewayRoot, "tenants.json"),
    port,
    host: process.env.HOST ?? "127.0.0.1",
    allowSignup: (process.env.ALLOW_SIGNUP ?? "false").toLowerCase() === "true",
    dbPath: process.env.DB_PATH ?? path.join(gatewayRoot, "data", "auth.sqlite"),
    ...overrides,
  };
}

export function requireSecret(config: GatewayConfig): void {
  if (!config.authSecret || config.authSecret.length < 32) {
    throw new Error(
      "AUTH_SECRET no está definido o es demasiado corto (mínimo 32 caracteres). " +
        'Genera uno con: openssl rand -hex 32 y ponlo en gateway/.env',
    );
  }
}
