/**
 * Utilidades de escape para las páginas HTML del gateway.
 *
 * Defensa en profundidad: aunque hoy los valores interpolados (BASE_URL, correo
 * del usuario, nombre del cliente OAuth) vengan de configuración o de la propia
 * base de datos, cualquiera de ellos podría contener `<` o comillas y romper el
 * documento. Todo valor dinámico pasa por aquí antes de entrar a una plantilla.
 */

/** Escapa un valor para interpolarlo en texto o en un atributo entre comillas. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
