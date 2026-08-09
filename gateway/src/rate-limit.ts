/**
 * Rate limit en memoria por IP (ventana deslizante de un minuto por defecto).
 *
 * - La clave de IP se deriva con `clientIpFrom`: detrás de Cloudflare/nginx se
 *   prefiere `cf-connecting-ip`; si no, el ÚLTIMO salto de X-Forwarded-For
 *   (el único que agrega el proxy de confianza, no falsificable por el
 *   cliente); si no hay cabeceras, "local".
 * - Las entradas del Map se purgan cuando su lista de hits queda vacía, para
 *   que un atacante no pueda hacer crecer el Map sin límite.
 */

export interface RateLimiter {
  /** true si la IP aún tiene cupo en la ventana; registra el hit si lo tiene. */
  ok(ip: string): boolean;
  /** Cantidad de IPs con hits vigentes (para tests/observabilidad). */
  size(): number;
}

export function createRateLimiter(limit: number, windowMs = 60_000): RateLimiter {
  const hits = new Map<string, number[]>();

  function sweep(now: number): void {
    for (const [key, times] of hits) {
      const recent = times.filter((t) => now - t < windowMs);
      if (recent.length === 0) hits.delete(key);
      else hits.set(key, recent);
    }
  }

  return {
    ok(ip: string): boolean {
      const now = Date.now();
      sweep(now);
      const recent = hits.get(ip) ?? [];
      if (recent.length >= limit) return false;
      recent.push(now);
      hits.set(ip, recent);
      return true;
    },
    size(): number {
      return hits.size;
    },
  };
}

/**
 * IP del cliente para rate limiting. NUNCA usa el primer valor de
 * X-Forwarded-For (controlado por el cliente): prefiere cf-connecting-ip
 * (Cloudflare) y, si no, el último salto de XFF (agregado por el proxy de
 * confianza).
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const last = headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return last || "local";
}
