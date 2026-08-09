/**
 * Endurecimiento de permisos de archivos con secretos.
 *
 * - `applyUmask` fija umask 077 lo antes posible para que todo archivo nuevo
 *   (SQLite -wal/-shm, logs, tenants.json) nazca sin permisos de grupo/otros.
 * - `hardenSecretFilePerms` hace chmod 600 de los archivos sensibles ya
 *   existentes al arrancar (auth.sqlite y sus -wal/-shm, tenants.json,
 *   gateway.log). Los ausentes se ignoran en silencio.
 */
import fs from "node:fs";
import path from "node:path";
import { gatewayRoot, type GatewayConfig } from "./env.js";

export function applyUmask(): void {
  process.umask(0o077);
}

export function hardenSecretFilePerms(
  config: GatewayConfig,
  logPath: string = path.join(gatewayRoot, "gateway.log"),
): string[] {
  const candidates: string[] = [];
  if (config.dbPath !== ":memory:") {
    candidates.push(config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`);
  }
  candidates.push(config.tenantsFile, logPath);

  const hardened: string[] = [];
  for (const p of candidates) {
    try {
      fs.chmodSync(p, 0o600);
      hardened.push(p);
    } catch {
      /* archivo ausente o inaccesible: nada que endurecer */
    }
  }
  return hardened;
}
