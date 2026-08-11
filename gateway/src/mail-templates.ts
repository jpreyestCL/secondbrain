/**
 * Plantillas de los correos transaccionales (en español, con parte HTML y
 * parte de texto plano).
 *
 * Reglas que siguen todas:
 *  - Dicen POR QUÉ llega el correo y qué hacer si no fuiste tú. Un correo de
 *    verificación sin contexto parece phishing, y con registro abierto
 *    cualquiera puede escribir la dirección de otra persona.
 *  - No prometen nada que el gateway no cumpla: el enlace caduca y se dice.
 *  - HTML sobrio y en tabla-libre (los clientes de correo no entienden CSS
 *    moderno); el texto plano lleva la URL completa para quien no ve HTML.
 */
import { escapeHtml } from "./html.js";

export interface MailContent {
  subject: string;
  html: string;
  text: string;
}

/** Host visible del gateway, para nombrarlo en el correo. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function hours(seconds: number): string {
  const h = Math.round(seconds / 3600);
  if (h >= 24 && h % 24 === 0) {
    const d = h / 24;
    return d === 1 ? "24 horas" : `${d} días`;
  }
  return h === 1 ? "1 hora" : `${h} horas`;
}

const FONT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function layout(opts: {
  title: string;
  intro: string;
  buttonLabel: string;
  url: string;
  expiry: string;
  reason: string;
}): string {
  const url = escapeHtml(opts.url);
  return `<!doctype html>
<html lang="es">
<body style="margin:0;padding:24px;background:#f5f5f4;${FONT};color:#1c1917;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:28px;">
    <h1 style="margin:0 0 16px;font-size:19px;">${escapeHtml(opts.title)}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">${opts.intro}</p>
    <p style="margin:0 0 20px;">
      <a href="${url}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px;font-size:15px;">${escapeHtml(opts.buttonLabel)}</a>
    </p>
    <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#57534e;">
      Si el botón no funciona, copia y pega este enlace en tu navegador:<br>
      <a href="${url}" style="color:#4f46e5;word-break:break-all;">${url}</a>
    </p>
    <p style="margin:0 0 16px;font-size:13px;color:#57534e;">El enlace caduca en ${escapeHtml(opts.expiry)}.</p>
    <hr style="border:0;border-top:1px solid #e7e5e4;margin:20px 0;">
    <p style="margin:0;font-size:12px;line-height:1.5;color:#78716c;">${opts.reason}</p>
  </div>
</body>
</html>`;
}

export interface VerificationMailOptions {
  /** URL de verificación (ya apunta al gateway). */
  url: string;
  /** URL pública del gateway, para nombrarlo. */
  baseUrl: string;
  /** Vigencia del enlace, en segundos. */
  expiresIn: number;
}

export function verificationMail(opts: VerificationMailOptions): MailContent {
  const host = hostOf(opts.baseUrl);
  const expiry = hours(opts.expiresIn);
  const reasonHtml =
    `Recibes este correo porque alguien creó una cuenta en <strong>${escapeHtml(host)}</strong> ` +
    "con esta dirección. Si no fuiste tú, ignora este mensaje: sin confirmar el " +
    "enlace la cuenta no queda verificada y nadie puede usar tu correo para " +
    "enlazar otros accesos.";
  const html = layout({
    title: "Confirma tu correo",
    intro:
      `Estás a un clic de activar tu memoria en <strong>${escapeHtml(host)}</strong>. ` +
      "Confirma que esta dirección es tuya:",
    buttonLabel: "Confirmar mi correo",
    url: opts.url,
    expiry,
    reason: reasonHtml,
  });
  const text = [
    "Confirma tu correo",
    "",
    `Estás a un clic de activar tu memoria en ${host}. Abre este enlace para`,
    "confirmar que esta dirección es tuya:",
    "",
    opts.url,
    "",
    `El enlace caduca en ${expiry}.`,
    "",
    `Recibes este correo porque alguien creó una cuenta en ${host} con esta`,
    "dirección. Si no fuiste tú, ignora este mensaje: sin confirmar el enlace la",
    "cuenta no queda verificada y nadie puede usar tu correo para enlazar otros",
    "accesos.",
  ].join("\n");

  return { subject: `Confirma tu correo en ${host}`, html, text };
}

export interface ResetPasswordMailOptions {
  url: string;
  baseUrl: string;
  expiresIn: number;
}

export function resetPasswordMail(opts: ResetPasswordMailOptions): MailContent {
  const host = hostOf(opts.baseUrl);
  const expiry = hours(opts.expiresIn);
  const reasonHtml =
    `Recibes este correo porque alguien pidió restablecer la contraseña de la cuenta de <strong>${escapeHtml(host)}</strong> ` +
    "asociada a esta dirección. Si no fuiste tú, ignora este mensaje: tu " +
    "contraseña actual sigue funcionando y no hace falta que hagas nada.";
  const html = layout({
    title: "Restablece tu contraseña",
    intro: `Pediste una contraseña nueva para tu cuenta en <strong>${escapeHtml(host)}</strong>. Elige una aquí:`,
    buttonLabel: "Elegir una contraseña nueva",
    url: opts.url,
    expiry,
    reason: reasonHtml,
  });
  const text = [
    "Restablece tu contraseña",
    "",
    `Pediste una contraseña nueva para tu cuenta en ${host}. Abre este enlace`,
    "para elegirla:",
    "",
    opts.url,
    "",
    `El enlace caduca en ${expiry}.`,
    "",
    "Recibes este correo porque alguien pidió restablecer la contraseña de la",
    `cuenta de ${host} asociada a esta dirección.`,
    "Si no fuiste tú, ignora este mensaje: tu contraseña actual sigue",
    "funcionando y no hace falta que hagas nada.",
  ].join("\n");

  return { subject: `Restablece tu contraseña en ${host}`, html, text };
}
