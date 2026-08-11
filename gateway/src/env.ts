import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAIL_FROM } from "./mailer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from src/ (tsx) and dist/ (compiled): gateway root is one level up.
export const gatewayRoot = path.resolve(here, "..");

/**
 * Modo de registro del gateway:
 *  - `open`   : cualquiera crea cuenta sin código (incluido Google).
 *  - `invite` : hace falta el REGISTRATION_CODE (también para Google).
 *  - `closed` : /registro responde 403 y Google no aprovisiona a nadie nuevo.
 */
export type RegistrationMode = "open" | "invite" | "closed";

const REGISTRATION_MODES: RegistrationMode[] = ["open", "invite", "closed"];

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
  /**
   * Modo de registro (REGISTRATION_MODE). Default `open`. Compatibilidad hacia
   * atrás: si REGISTRATION_MODE no está definido pero REGISTRATION_CODE sí,
   * el modo efectivo es `invite`.
   */
  registrationMode: RegistrationMode;
  /**
   * VÁLVULA DE SEGURIDAD (MAX_TENANTS, default 5). Tope duro de tenants que
   * esta instancia acepta aprovisionar. Antes de crear ninguna cuenta se
   * cuentan las entradas de tenants.json; al alcanzar el tope el registro se
   * cierra temporalmente (no se crea usuario ni se aprovisiona nada).
   *
   * Por qué existe: el servidor tiene ~1 GB de RAM libre y el MCP de cada
   * tenant corre con MemoryMax=500M, así que un registro sin tope puede dejar
   * la máquina sin memoria — y en esa misma máquina viven las apps de
   * producción del dueño.
   */
  maxTenants: number;
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
  /**
   * Clave de API de Resend. VACÍA => el correo queda DESHABILITADO: no se
   * envían verificaciones ni recuperaciones de contraseña, pero el gateway
   * sigue funcionando y el registro muestra "verificación pendiente" en vez de
   * romperse. Ver src/mailer.ts.
   */
  resendApiKey: string;
  /**
   * Remitente de los correos (`Nombre <correo@dominio>`). El dominio tiene que
   * estar VERIFICADO en Resend; mientras no lo esté, `onboarding@resend.dev`
   * solo puede escribirle a la dirección dueña de la cuenta de Resend.
   */
  mailFrom: string;
  /**
   * MAIL_DEBUG=1: los correos se escriben en el log en vez de enviarse. Es el
   * modo de los tests y del desarrollo local.
   */
  mailDebug: boolean;
  /** Vigencia del enlace de verificación de correo, en segundos (default 24 h). */
  emailVerificationExpiresIn: number;
  /** Vigencia del enlace de recuperación de contraseña, en segundos (default 1 h). */
  passwordResetExpiresIn: number;
  /** Máximo de correos (verificación/recuperación) por IP por minuto. */
  mailRateLimit: number;
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

/** REGISTRATION_MODE del entorno, o null si falta / no es un valor conocido. */
function envRegistrationMode(): RegistrationMode | null {
  const raw = (process.env.REGISTRATION_MODE ?? "").trim().toLowerCase();
  return (REGISTRATION_MODES as string[]).includes(raw) ? (raw as RegistrationMode) : null;
}

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const port = Number(process.env.PORT ?? 8787);
  const baseUrl = (process.env.BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const authSecret = process.env.AUTH_SECRET ?? "";
  const config: GatewayConfig = {
    baseUrl,
    authSecret,
    graphitiMcpUrl: process.env.GRAPHITI_MCP_URL ?? "http://127.0.0.1:8020/mcp",
    tenantsFile: process.env.TENANTS_FILE ?? path.join(gatewayRoot, "tenants.json"),
    port,
    host: process.env.HOST ?? "127.0.0.1",
    allowSignup: (process.env.ALLOW_SIGNUP ?? "false").toLowerCase() === "true",
    dbPath: process.env.DB_PATH ?? path.join(gatewayRoot, "data", "auth.sqlite"),
    registrationCode: (process.env.REGISTRATION_CODE ?? "").trim(),
    registrationMode: envRegistrationMode() ?? "open",
    maxTenants: positive(process.env.MAX_TENANTS, 5),
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
    resendApiKey: (process.env.RESEND_API_KEY ?? "").trim(),
    mailFrom: (process.env.MAIL_FROM ?? DEFAULT_MAIL_FROM).trim(),
    mailDebug: ["1", "true", "yes"].includes(
      (process.env.MAIL_DEBUG ?? "").trim().toLowerCase(),
    ),
    emailVerificationExpiresIn: positive(
      process.env.EMAIL_VERIFICATION_EXPIRES_IN,
      24 * 60 * 60,
    ),
    passwordResetExpiresIn: positive(process.env.PASSWORD_RESET_EXPIRES_IN, 60 * 60),
    mailRateLimit: positive(process.env.MAIL_RATE_LIMIT, 5),
    exportMaxEpisodes: positive(process.env.EXPORT_MAX_EPISODES, 1000),
    exportMaxNodes: positive(process.env.EXPORT_MAX_NODES, 500),
    ...overrides,
  };

  // Compatibilidad hacia atrás: sin REGISTRATION_MODE explícito (ni en el
  // entorno ni en los overrides), un REGISTRATION_CODE presente significa
  // "solo por invitación", que era el comportamiento anterior.
  if (!overrides.registrationMode && !envRegistrationMode()) {
    config.registrationMode = config.registrationCode.length > 0 ? "invite" : "open";
  }
  return config;
}

export function requireSecret(config: GatewayConfig): void {
  if (!config.authSecret || config.authSecret.length < 32) {
    throw new Error(
      "AUTH_SECRET no está definido o es demasiado corto (mínimo 32 caracteres). " +
        'Genera uno con: openssl rand -hex 32 y ponlo en gateway/.env',
    );
  }
}
