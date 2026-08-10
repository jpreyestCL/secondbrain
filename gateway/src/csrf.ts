/**
 * Protección CSRF de los formularios autenticados del gateway
 * (/consentimiento, /cuenta/...).
 *
 * Dos capas independientes:
 *  1. Same-origin: el header Origin (o, si falta, Referer) debe coincidir con
 *     el origen del propio gateway. Una petición cross-site de un navegador
 *     moderno SIEMPRE manda Origin en POST, así que un formulario alojado en
 *     otro dominio se rechaza aunque la cookie viaje (SameSite=Lax no protege
 *     los POST top-level en todos los navegadores/versiones).
 *  2. Token: HMAC-SHA256(idDeSesión, AUTH_SECRET) incrustado en el formulario.
 *     Un atacante no puede leerlo (no puede leer la respuesta cross-origin) ni
 *     calcularlo (no conoce AUTH_SECRET ni el id de sesión).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CSRF_FIELD = "csrf";

/** Token CSRF ligado a la sesión actual. */
export function csrfToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("hex");
}

/** Verifica el token en tiempo constante. */
export function verifyCsrfToken(
  token: unknown,
  sessionId: string,
  secret: string,
): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(csrfToken(sessionId, secret));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * ¿La petición viene del propio gateway? Se acepta el origen público
 * configurado (BASE_URL) y el origen real de la petición — detrás de un túnel
 * o en los tests el listener escucha en otro host/puerto.
 */
export function isSameOrigin(req: Request, baseUrl: string): boolean {
  const origin = req.headers.get("origin") ?? originOf(req.headers.get("referer"));
  if (!origin) return false; // POST sin Origin: se rechaza por defecto
  const allowed = new Set([originOf(baseUrl), originOf(req.url)].filter(Boolean));
  return allowed.has(origin);
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
