/**
 * Cookie corta de "código de invitación validado" para el registro vía Google.
 *
 * Flujo: en /registro el usuario ingresa un código válido ANTES de poder usar
 * "Continuar con Google". Al validarlo (server-side, tiempo constante) se emite
 * esta cookie httpOnly de vida corta cuyo valor es el HMAC-SHA256 del código con
 * AUTH_SECRET. Tras el callback de Google, /post-google exige esta cookie para
 * aprovisionar el tenant de un usuario nuevo. Sin cookie válida NO se aprovisiona.
 *
 * El valor es HMAC(código) — no contiene el código en claro y si el
 * REGISTRATION_CODE rota, las cookies viejas dejan de validar automáticamente.
 * La expiración se aplica vía Max-Age de la cookie (COOKIE_MAX_AGE_SECONDS).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const REGISTRO_COOKIE_NAME = "registro_ok";
/** Vida de la cookie: 10 minutos. */
export const REGISTRO_COOKIE_MAX_AGE = 10 * 60;

/** HMAC-SHA256(code, secret) en hex. Valor que se guarda en la cookie. */
export function registroOkValue(code: string, secret: string): string {
  return createHmac("sha256", secret).update(code).digest("hex");
}

/** Verifica (en tiempo constante) que la cookie corresponda al código actual. */
export function verifyRegistroOk(
  cookieValue: string | undefined | null,
  code: string,
  secret: string,
): boolean {
  if (!cookieValue || !code) return false;
  const expected = registroOkValue(code, secret);
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
