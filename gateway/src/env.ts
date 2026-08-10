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
  /**
   * Invite code for self-service registration at /registro. Empty/unset means
   * registration is CLOSED (the page shows "registro deshabilitado").
   * Independent of ALLOW_SIGNUP, which governs OPEN signup without a code.
   */
  registrationCode: string;
  /** Root of the second-brain repo (contains infra/). Default: gateway/.. */
  brainRepoRoot: string;
  /**
   * Command template used to provision a tenant. {slug} and {port} are
   * replaced; if the template has no placeholders the two values are appended
   * as arguments. Executed with cwd = brainRepoRoot.
   */
  provisionCmd: string;
  /** First MCP port considered when allocating a port for a new tenant. */
  tenantPortBase: number;
  /** Max POST /registro requests per IP per minute (in-memory). */
  registroRateLimit: number;
  /** Max Dynamic Client Registration (/api/auth/mcp/register) requests per IP per minute. */
  dcrRateLimit: number;
  /** Hosts cuyos redirect_uri se aceptan en el flujo OAuth (allowlist). */
  allowedRedirectHosts: string[];
  /**
   * Google OAuth client id. Vacío => "Continuar con Google" queda deshabilitado
   * en todas partes (sin botón, sin proveedor social). Requiere también
   * googleClientSecret; si falta cualquiera de los dos, Google se desactiva.
   */
  googleClientId: string;
  /** Google OAuth client secret. Ver googleClientId. */
  googleClientSecret: string;
  /**
   * Vida de la cookie de sesión, en días (SESSION_MAX_AGE_DAYS, default 2).
   * Antes eran 7 días fijos: una cookie robada valía una semana. Con rotación
   * (sessionUpdateAgeMinutes) la actividad la extiende, así que un valor corto
   * no molesta a quien usa el gateway a diario.
   */
  sessionMaxAgeDays: number;
  /**
   * Cada cuántos minutos de actividad se refresca (rota) la expiración de la
   * sesión. SESSION_UPDATE_AGE_MINUTES, default 60. 0 => en cada petición.
   */
  sessionUpdateAgeMinutes: number;
  /** Máximo de episodios que /export pide al MCP del tenant. */
  exportMaxEpisodes: number;
  /** Máximo de entidades/hechos que /export pide al MCP del tenant. */
  exportMaxNodes: number;
}

/** Número > 0 desde el entorno; cualquier basura cae al default. */
function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Número >= 0 desde el entorno; cualquier basura cae al default. */
function nonNegative(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
    registrationCode: (process.env.REGISTRATION_CODE ?? "").trim(),
    brainRepoRoot: path.resolve(gatewayRoot, process.env.BRAIN_REPO_ROOT ?? ".."),
    provisionCmd:
      process.env.PROVISION_CMD ?? "bash infra/scripts/provision-tenant.sh {slug} {port}",
    tenantPortBase: Number(process.env.TENANT_PORT_BASE ?? 9021),
    registroRateLimit: Number(process.env.REGISTRO_RATE_LIMIT ?? 5),
    dcrRateLimit: Number(process.env.DCR_RATE_LIMIT ?? 20),
    // Allowlist de destinos OAuth. Por defecto solo los clientes MCP oficiales;
    // ampliable con ALLOWED_REDIRECT_HOSTS (separados por coma). Sin esto,
    // cualquiera registra un cliente que apunte a su dominio y roba el token.
    allowedRedirectHosts: (
      process.env.ALLOWED_REDIRECT_HOSTS ?? "claude.ai,claude.com,anthropic.com"
    )
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    googleClientId: (process.env.GOOGLE_CLIENT_ID ?? "").trim(),
    googleClientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
    sessionMaxAgeDays: positive(process.env.SESSION_MAX_AGE_DAYS, 2),
    sessionUpdateAgeMinutes: nonNegative(process.env.SESSION_UPDATE_AGE_MINUTES, 60),
    exportMaxEpisodes: positive(process.env.EXPORT_MAX_EPISODES, 1000),
    exportMaxNodes: positive(process.env.EXPORT_MAX_NODES, 500),
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
