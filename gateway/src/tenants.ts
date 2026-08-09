/**
 * Registro de tenants: mapea cada usuario (por email o por userId de
 * Better Auth) a SU servidor MCP de Graphiti upstream.
 *
 * Formato de gateway/tenants.json:
 * {
 *   "jpreyest@gmail.com": "http://127.0.0.1:8021/mcp",
 *   "otra@persona.cl":    "http://127.0.0.1:8022/mcp"
 * }
 *
 * Aislamiento duro: cada tenant tiene su propio contenedor Graphiti con su
 * propio grafo. NUNCA hay un upstream por defecto: un usuario sin mapeo
 * recibe 403. El archivo se recarga automáticamente cuando cambia (mtime).
 */
import fs from "node:fs";

export interface TenantRegistry {
  /** Resolve the upstream MCP URL for a user, matching userId first, then email. */
  resolveUpstream(userId: string, email: string | null): string | null;
  /** Add or replace a mapping and persist it. */
  setMapping(key: string, upstreamUrl: string): void;
  readonly filePath: string;
}

type Mapping = Record<string, string>;

export function createTenantRegistry(filePath: string): TenantRegistry {
  let cache: Mapping = {};
  let cachedMtimeMs = -1;

  function load(): Mapping {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // Archivo ausente => sin tenants. Jamás un default.
      cache = {};
      cachedMtimeMs = -1;
      return cache;
    }
    if (stat.mtimeMs !== cachedMtimeMs) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${filePath} debe contener un objeto JSON {clave: url}`);
      }
      const next: Mapping = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string" || !/^https?:\/\//.test(value)) {
          throw new Error(`Mapeo inválido para "${key}" en ${filePath}: debe ser una URL http(s)`);
        }
        next[key.trim().toLowerCase()] = value;
      }
      cache = next;
      cachedMtimeMs = stat.mtimeMs;
    }
    return cache;
  }

  return {
    filePath,
    resolveUpstream(userId, email) {
      const mapping = load();
      const byId = mapping[userId.trim().toLowerCase()];
      if (byId) return byId;
      if (email) {
        const byEmail = mapping[email.trim().toLowerCase()];
        if (byEmail) return byEmail;
      }
      return null;
    },
    setMapping(key, upstreamUrl) {
      const mapping = { ...load(), [key.trim().toLowerCase()]: upstreamUrl };
      fs.writeFileSync(filePath, JSON.stringify(mapping, null, 2) + "\n");
      cachedMtimeMs = -1; // force reload on next resolve
    },
  };
}
