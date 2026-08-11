/**
 * Cliente mínimo de Resend sobre `fetch` (sin dependencias nuevas) + registro
 * en memoria del resultado del último envío por dirección.
 *
 * Por qué así:
 *  - Resend no necesita SDK: es un POST JSON a https://api.resend.com/emails.
 *    Añadir `resend` como dependencia solo para eso trae más superficie que
 *    valor, y `fetch` ya es global en Node >= 22 (el engine que exige el
 *    package.json).
 *  - `RESEND_API_KEY` vacío => correo DESHABILITADO. No es un error fatal: el
 *    gateway sigue funcionando y quien llama degrada con elegancia (el registro
 *    crea la cuenta igual y muestra "verificación pendiente"). Enviar lanza
 *    `MailError` con code `mail_disabled` para que haya UN solo camino de
 *    error en los llamadores.
 *  - `MAIL_DEBUG=1` => no se toca la red: el correo se vuelca al log. Es lo que
 *    usan los tests y el desarrollo local mientras el dominio siga pendiente de
 *    verificación en Resend.
 *
 * IMPORTANTE: `fetch` se resuelve en cada envío desde `globalThis` para que los
 * tests puedan sustituirlo sin tocar la red.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailResult {
  /** Id que devuelve Resend, o null en modo debug. */
  id: string | null;
  /** true cuando el correo se registró en el log en vez de enviarse. */
  debug: boolean;
}

/** Error tipado de correo. `code` distingue el motivo sin parsear mensajes. */
export class MailError extends Error {
  readonly code: "mail_disabled" | "resend_error" | "network_error";
  readonly status: number | null;

  constructor(
    code: MailError["code"],
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "MailError";
    this.code = code;
    this.status = status;
  }
}

export interface MailerConfigView {
  /** Clave de API de Resend. Vacía => correo deshabilitado. */
  resendApiKey: string;
  /** Remitente (`Nombre <correo@dominio>`). */
  mailFrom: string;
  /** true => se registra en el log y NO se envía nada. */
  mailDebug: boolean;
}

export interface Mailer {
  /** false cuando no hay RESEND_API_KEY (y no estamos en modo debug). */
  readonly enabled: boolean;
  /** true cuando los correos se vuelcan al log en vez de enviarse. */
  readonly debug: boolean;
  readonly from: string;
  send(message: MailMessage): Promise<MailResult>;
}

/** Forma del error de la API de Resend (4xx/5xx). */
interface ResendError {
  statusCode?: number;
  name?: string;
  message?: string;
  error?: string;
}

export const DEFAULT_MAIL_FROM = "Second Brain <onboarding@resend.dev>";

export function createMailer(config: MailerConfigView): Mailer {
  const apiKey = config.resendApiKey.trim();
  const from = config.mailFrom.trim() || DEFAULT_MAIL_FROM;
  const debug = config.mailDebug;
  const enabled = debug || apiKey.length > 0;

  if (!enabled) {
    console.warn(
      "[mail] DESHABILITADO: falta RESEND_API_KEY. No se enviarán correos de " +
        "verificación ni de recuperación de contraseña. El registro sigue " +
        "funcionando y mostrará 'verificación pendiente'.",
    );
  } else if (debug) {
    console.warn("[mail] MAIL_DEBUG=1: los correos se escriben en el log, NO se envían.");
  }

  return {
    enabled,
    debug,
    from,
    async send(message: MailMessage): Promise<MailResult> {
      if (debug) {
        console.log(
          `[mail:debug] para=${message.to} asunto=${message.subject}\n` +
            `----- texto -----\n${message.text}\n-----------------`,
        );
        return { id: null, debug: true };
      }
      if (!apiKey) {
        throw new MailError(
          "mail_disabled",
          "Correo deshabilitado: falta RESEND_API_KEY.",
        );
      }

      const payload = {
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      };

      let res: Response;
      try {
        res = await globalThis.fetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        throw new MailError(
          "network_error",
          `No se pudo contactar a Resend: ${(err as Error).message}`,
        );
      }

      if (!res.ok) {
        // Resend devuelve {statusCode, name, message}; si no se puede parsear
        // se usa el cuerpo crudo para que el log sirva de algo.
        let detail = "";
        const raw = await res.text().catch(() => "");
        try {
          const parsed = JSON.parse(raw) as ResendError;
          detail = parsed.message ?? parsed.error ?? parsed.name ?? raw;
        } catch {
          detail = raw;
        }
        throw new MailError(
          "resend_error",
          `Resend respondió ${res.status}: ${detail || "sin detalle"}`,
          res.status,
        );
      }

      const body = (await res.json().catch(() => ({}))) as { id?: string };
      return { id: body.id ?? null, debug: false };
    },
  };
}

// --- Registro del último envío por dirección -------------------------------
// El callback `sendVerificationEmail` de Better Auth NO puede lanzar: si lo
// hiciera, el sign-up entero fallaría DESPUÉS de haber creado el usuario y el
// registro mostraría "no se pudo crear la cuenta" sobre una cuenta que sí
// existe. Así que el callback captura el fallo y lo apunta aquí; /registro lo
// consulta para decidir si enseña "te enviamos el correo" o "verificación
// pendiente" con un botón de reenvío.
//
// Es un singleton de proceso a propósito: el gateway es un solo proceso y así
// no hay que enhebrar el objeto por cinco constructores. Está acotado en
// tamaño y en tiempo para que nadie lo haga crecer mandando correos falsos.

export interface DeliveryOutcome {
  ok: boolean;
  at: number;
  /** Mensaje del fallo (solo para el operador; nunca se muestra al usuario). */
  error?: string;
}

const DELIVERY_TTL_MS = 15 * 60_000;
const DELIVERY_MAX = 200;
const deliveries = new Map<string, DeliveryOutcome>();

function purgeDeliveries(now: number): void {
  for (const [key, outcome] of deliveries) {
    if (now - outcome.at > DELIVERY_TTL_MS) deliveries.delete(key);
  }
  while (deliveries.size > DELIVERY_MAX) {
    const oldest = deliveries.keys().next();
    if (oldest.done) break;
    deliveries.delete(oldest.value);
  }
}

export function recordDelivery(email: string, outcome: Omit<DeliveryOutcome, "at">): void {
  const now = Date.now();
  const key = email.trim().toLowerCase();
  deliveries.delete(key); // re-inserta al final: el Map queda ordenado por edad
  deliveries.set(key, { ...outcome, at: now });
  purgeDeliveries(now);
}

/** Resultado del último envío a esa dirección, o null si no hay registro. */
export function lastDelivery(email: string): DeliveryOutcome | null {
  const now = Date.now();
  const key = email.trim().toLowerCase();
  const outcome = deliveries.get(key);
  if (!outcome) return null;
  if (now - outcome.at > DELIVERY_TTL_MS) {
    deliveries.delete(key);
    return null;
  }
  return outcome;
}

/** Solo para tests. */
export function resetDeliveries(): void {
  deliveries.clear();
}
