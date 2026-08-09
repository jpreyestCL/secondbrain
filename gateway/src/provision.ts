/**
 * Aprovisionamiento automático de tenants para el registro self-service.
 *
 * - Deriva el slug del tenant desde la parte local del email
 *   (minúsculas, [a-z0-9_-], colisiones con sufijo numérico -2, -3, …).
 * - Asigna el siguiente puerto MCP libre (base configurable, default 9021)
 *   escaneando infra/tenants/*.env bajo BRAIN_REPO_ROOT.
 * - Ejecuta el comando de aprovisionamiento (PROVISION_CMD) con
 *   cwd = BRAIN_REPO_ROOT.
 * - Serializa aprovisionamientos concurrentes con una cola en proceso, y
 *   reserva slug/puerto en memoria para que dos registros simultáneos jamás
 *   reciban el mismo par.
 */
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import type { GatewayConfig } from "./env.js";

export interface ProvisionResult {
  slug: string;
  port: number;
  upstreamUrl: string;
}

export interface Provisioner {
  /** Aprovisiona el tenant para un email. Serializado; lanza si el comando falla. */
  provision(email: string): Promise<ProvisionResult>;
}

/** Parte local del email -> slug válido para add-tenant.sh ([a-z0-9][a-z0-9_-]*). */
export function slugFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  const slug = local
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/[-_]+$/, "");
  return /^[a-z0-9]/.test(slug) ? slug : `t${slug ? "-" + slug : "enant"}`;
}

/** Slugs ya usados = archivos infra/tenants/<slug>.env (sin la plantilla). */
export function takenSlugs(tenantsDir: string): Set<string> {
  const taken = new Set<string>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(tenantsDir);
  } catch {
    return taken; // directorio ausente => nada tomado
  }
  for (const name of entries) {
    if (!name.endsWith(".env")) continue;
    const base = name.slice(0, -".env".length);
    if (base === "tenant" || base === "tenant.env") continue; // plantilla
    taken.add(base);
  }
  return taken;
}

/** Puertos MCP en uso según MCP_PORT= en infra/tenants/*.env. */
export function usedPorts(tenantsDir: string): Set<number> {
  const used = new Set<number>();
  for (const slug of takenSlugs(tenantsDir)) {
    try {
      const raw = fs.readFileSync(path.join(tenantsDir, `${slug}.env`), "utf8");
      const m = raw.match(/^MCP_PORT=(\d+)\s*$/m);
      if (m) used.add(Number(m[1]));
    } catch {
      /* archivo ilegible: lo ignoramos para la asignación */
    }
  }
  return used;
}

export function dedupeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function nextFreePort(portBase: number, used: ReadonlySet<number>): number {
  for (let p = portBase; ; p++) {
    if (!used.has(p)) return p;
  }
}

function buildCommand(template: string, slug: string, port: number): string {
  if (template.includes("{slug}") || template.includes("{port}")) {
    return template.replaceAll("{slug}", slug).replaceAll("{port}", String(port));
  }
  return `${template} ${slug} ${port}`;
}

const PROVISION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Redacta valores de variables tipo PASSWORD/SECRET/KEY en salida capturada
 * de comandos antes de mandarla a consola/log.
 */
export function redactSecrets(text: string): string {
  return text.replace(
    /\b([A-Za-z0-9_]*(?:PASSWORD|SECRET|KEY)[A-Za-z0-9_]*\s*=)[^\s'"]+/gi,
    "$1[REDACTED]",
  );
}

export function createProvisioner(config: GatewayConfig): Provisioner {
  const tenantsDir = path.join(config.brainRepoRoot, "infra", "tenants");
  // Reservas en memoria: cubren la ventana entre asignar y que el script
  // escriba el .env del tenant (y quedan si el script falló a medias).
  const reservedSlugs = new Set<string>();
  const reservedPorts = new Set<number>();

  // Cola simple: cada provisión espera a que termine la anterior.
  let chain: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function runCommand(cmd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      exec(
        cmd,
        {
          cwd: config.brainRepoRoot,
          timeout: PROVISION_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            const err = new Error(
              `PROVISION_CMD falló (${cmd}): ${error.message}\n--- stdout ---\n${redactSecrets(
                stdout,
              )}\n--- stderr ---\n${redactSecrets(stderr)}`,
            );
            reject(err);
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
    });
  }

  return {
    provision(email: string): Promise<ProvisionResult> {
      return serialize(async () => {
        const slugsTaken = new Set([...takenSlugs(tenantsDir), ...reservedSlugs]);
        const portsUsed = new Set([...usedPorts(tenantsDir), ...reservedPorts]);
        const slug = dedupeSlug(slugFromEmail(email), slugsTaken);
        const port = nextFreePort(config.tenantPortBase, portsUsed);
        reservedSlugs.add(slug);
        reservedPorts.add(port);

        // Si el comando FALLA (no escribió el .env del tenant), liberamos la
        // reserva para que el próximo registro pueda reutilizar slug/puerto.
        let success = false;
        try {
          const cmd = buildCommand(config.provisionCmd, slug, port);
          console.log(`[registro] aprovisionando tenant slug=${slug} port=${port}: ${cmd}`);
          const { stdout, stderr } = await runCommand(cmd);
          if (stdout.trim())
            console.log(`[registro] provision stdout:\n${redactSecrets(stdout.trim())}`);
          if (stderr.trim())
            console.log(`[registro] provision stderr:\n${redactSecrets(stderr.trim())}`);

          success = true;
          return { slug, port, upstreamUrl: `http://127.0.0.1:${port}/mcp` };
        } finally {
          if (!success) {
            reservedSlugs.delete(slug);
            reservedPorts.delete(port);
          }
        }
      });
    },
  };
}
