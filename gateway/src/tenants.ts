/**
 * Registro de tenants: mapea cada usuario (por email o por userId de
 * Better Auth) a SU servidor MCP de Graphiti upstream.
 *
 * Formato de gateway/tenants.json (dos formas, ambas validas):
 * {
 *   "jpreyest@gmail.com": "http://127.0.0.1:8021/mcp",
 *   "otra@persona.cl":    { "url": "http://127.0.0.1:8022/mcp", "slug": "otra-2" }
 * }
 *
 * La forma con objeto guarda ademas el SLUG del tenant, que es el nombre de su
 * grafo y el valor que el CLI `brain --tenant <slug>` necesita. No se puede
 * derivar del email: si el slug ya estaba tomado, el aprovisionamiento le pone
 * un sufijo (`juan-2`). Las entradas antiguas en forma de string se siguen
 * leyendo; para ellas el slug queda en null.
 *
 * Aislamiento duro: cada tenant tiene su propio contenedor Graphiti con su
 * propio grafo. NUNCA hay un upstream por defecto: un usuario sin mapeo
 * recibe 403. El archivo se recarga automáticamente cuando cambia (mtime).
 */
import fs from "node:fs";

export interface TenantRegistry {
  /** Resolve the upstream MCP URL for a user, matching userId first, then email. */
  resolveUpstream(userId: string, email: string | null): string | null;
  /** Como resolveUpstream, pero devuelve tambien el slug si esta registrado. */
  resolveTenant(userId: string, email: string | null): TenantEntry | null;
  /** Add or replace a mapping and persist it. */
  setMapping(key: string, upstreamUrl: string, slug?: string): void;
  /**
   * Cuántos tenants hay mapeados ahora mismo. Lo usa la válvula MAX_TENANTS
   * antes de crear ninguna cuenta: cada tenant levanta un MCP con
   * MemoryMax=500M y la máquina tiene ~1 GB libre.
   */
  count(): number;
  readonly filePath: string;
}

export interface TenantEntry {
  url: string;
  /** null en mapeos antiguos, escritos antes de guardar el slug. */
  slug: string | null;
}

type Mapping = Record<string, TenantEntry>;

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
        const url = typeof value === "string" ? value : (value as TenantEntry)?.url;
        if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
          throw new Error(
            `Mapeo inválido para "${key}" en ${filePath}: debe ser una URL http(s) ` +
              `o un objeto {url, slug}`,
          );
        }
        const rawSlug = typeof value === "string" ? null : (value as TenantEntry)?.slug;
        next[key.trim().toLowerCase()] = {
          url,
          slug: typeof rawSlug === "string" && rawSlug.trim() ? rawSlug.trim() : null,
        };
      }
      cache = next;
      cachedMtimeMs = stat.mtimeMs;
    }
    return cache;
  }

  function buscar(userId: string, email: string | null): TenantEntry | null {
    const mapping = load();
    const byId = mapping[userId.trim().toLowerCase()];
    if (byId) return byId;
    if (email) {
      const byEmail = mapping[email.trim().toLowerCase()];
      if (byEmail) return byEmail;
    }
    return null;
  }

  return {
    filePath,
    resolveUpstream(userId, email) {
      // No usa `this`: el registro se pasa por ahi desestructurado en algunos
      // sitios y un `this` suelto quedaria en undefined.
      return buscar(userId, email)?.url ?? null;
    },
    resolveTenant(userId, email) {
      return buscar(userId, email);
    },
    count() {
      return Object.keys(load()).length;
    },
    setMapping(key, upstreamUrl, slug) {
      const entry: TenantEntry = { url: upstreamUrl, slug: slug ?? null };
      const mapping = { ...load(), [key.trim().toLowerCase()]: entry };
      // Escritura atómica: tmp en el mismo directorio + rename.
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2) + "\n");
      fs.renameSync(tmp, filePath);
      cachedMtimeMs = -1; // force reload on next resolve
    },
  };
}
