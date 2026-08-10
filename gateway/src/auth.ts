import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { mcp } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import type { GatewayConfig } from "./env.js";
import { createMailer, recordDelivery, type Mailer } from "./mailer.js";
import { verificationMail, resetPasswordMail } from "./mail-templates.js";

export type Auth = ReturnType<typeof createAuth>["auth"];

export interface CreateAuthOptions {
  /**
   * Kept for backwards compatibility (CLI scripts). Sign-up is now always
   * enabled at the Better Auth level; the PUBLIC endpoint
   * /api/auth/sign-up/* is gated in the HTTP layer (server.ts) according to
   * ALLOW_SIGNUP. This lets the code-gated /registro flow and the CLIs call
   * auth.api.signUpEmail() server-side even with ALLOW_SIGNUP=false.
   */
  forceAllowSignup?: boolean;
  /** Cliente de correo (inyectable en tests). Default: `createMailer(config)`. */
  mailer?: Mailer;
}

/**
 * Página a la que aterriza quien confirma su correo. Better Auth la recibe como
 * `callbackURL` del enlace de verificación y redirige allí (con `?error=CÓDIGO`
 * si el token es inválido o caducó).
 */
export const VERIFY_CALLBACK_PATH = "/verificado";

/** Página del formulario "elige una contraseña nueva" (recibe `?token=...`). */
export const RESET_PASSWORD_PATH = "/restablecer-password";

/**
 * Fuerza el `callbackURL` del enlace de verificación.
 *
 * Better Auth compone `.../verify-email?token=…&callbackURL=…` usando el
 * `callbackURL` del cuerpo de la petición, y por defecto es `/`. Quien confirma
 * su correo aterrizaría en la landing sin enterarse de nada, así que se
 * reescribe a la página de "cuenta lista". Es un parámetro relativo del propio
 * gateway, así que pasa el `originCheck` de Better Auth.
 */
export function withCallback(url: string, callbackPath: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("callbackURL", callbackPath);
    return u.toString();
  } catch {
    return url;
  }
}

export function createAuth(config: GatewayConfig, opts: CreateAuthOptions = {}) {
  if (config.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");

  const mailer = opts.mailer ?? createMailer(config);

  // Google es OPCIONAL: solo se registra el proveedor social cuando AMBAS
  // credenciales están presentes. Si falta cualquiera, Google queda deshabilitado
  // por completo (sin crash, sin proveedor). El callback de Google
  // (/api/auth/callback/google) redirige a /post-google, la ruta que hace cumplir
  // el gate de invitación (ver server.ts) — Google NUNCA aprovisiona por su cuenta.
  const googleEnabled = Boolean(config.googleClientId && config.googleClientSecret);
  const socialProviders = googleEnabled
    ? {
        google: {
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
        },
      }
    : undefined;

  const auth = betterAuth({
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    database: db,
    trustedOrigins: [config.baseUrl],
    ...(socialProviders ? { socialProviders } : {}),
    // Enlazar la cuenta de Google con la de email+contraseña del MISMO correo.
    // Sin `trustedProviders`, Better Auth rechaza el login con
    // `error=account_not_linked` cuando el correo ya existe con contraseña.
    // Es seguro para Google porque verifica el correo antes de emitirlo; NO
    // añadir aquí proveedores que no lo hagan (permitiría tomar una cuenta
    // registrando ese correo en el proveedor).
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
      },
    },
    // --- Verificación de correo ------------------------------------------
    // Con registro ABIERTO cualquiera puede escribir la dirección de otra
    // persona, así que hay que probar que el correo es suyo. Además desbloquea
    // el enlace con Google: link-account.mjs rechaza enlazar mientras
    // `requireLocalEmailVerified` (default true) y el usuario local no esté
    // verificado. NO se baja esa opción a false: con registro abierto eso
    // permitiría un secuestro de cuenta (alguien registra tu correo con
    // contraseña y hereda tu sesión cuando entras con Google).
    emailVerification: {
      sendOnSignUp: true,
      // Verificar NO inicia sesión sola: la persona vuelve a /login (o sigue
      // con la sesión que ya tuviera). Un enlace de correo que crea sesión es
      // un vector barato para quien lea el buzón.
      autoSignInAfterVerification: false,
      expiresIn: config.emailVerificationExpiresIn,
      async sendVerificationEmail({ user, url }) {
        // Este callback NUNCA lanza: Better Auth lo llama DESPUÉS de crear el
        // usuario dentro de /sign-up/email, así que un throw dejaría la cuenta
        // creada y el registro devolviendo "no se pudo crear la cuenta". El
        // fallo se apunta en el registro de envíos y /registro decide qué
        // página mostrar (éxito o "verificación pendiente" con reenvío).
        const target = withCallback(url, VERIFY_CALLBACK_PATH);
        const mail = verificationMail({
          url: target,
          baseUrl: config.baseUrl,
          expiresIn: config.emailVerificationExpiresIn,
        });
        try {
          await mailer.send({ to: user.email, ...mail });
          recordDelivery(user.email, { ok: true });
          console.log(`[mail] verificación enviada a ${user.email}`);
        } catch (err) {
          recordDelivery(user.email, { ok: false, error: (err as Error).message });
          console.error(`[mail] FALLÓ la verificación de ${user.email}:`, err);
        }
      },
    },
    emailAndPassword: {
      enabled: true,
      // El gate del endpoint público vive en server.ts (ver CreateAuthOptions).
      disableSignUp: false,
      // Deliberadamente false: si exigiera verificación para iniciar sesión,
      // cualquier caída del correo (hoy el dominio de Resend está pendiente de
      // DNS) dejaría a TODO el mundo fuera, incluida gente ya aprovisionada.
      // La verificación sirve para enlazar Google y se muestra en /cuenta.
      requireEmailVerification: false,
      minPasswordLength: 10,
      resetPasswordTokenExpiresIn: config.passwordResetExpiresIn,
      // Cambiar la contraseña cierra las demás sesiones: si alguien entró con
      // la contraseña vieja, el restablecimiento lo echa.
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        // Better Auth ejecuta este callback con `runInBackgroundOrAwait`, que
        // se traga cualquier excepción; así que el fallo se registra aquí (log
        // + registro de envíos) en vez de confiar en que alguien lo vea. La
        // respuesta al usuario es NEUTRA en todos los casos: nunca revela si
        // esa dirección tiene cuenta.
        const mail = resetPasswordMail({
          url,
          baseUrl: config.baseUrl,
          expiresIn: config.passwordResetExpiresIn,
        });
        try {
          await mailer.send({ to: user.email, ...mail });
          recordDelivery(user.email, { ok: true });
          console.log(`[mail] recuperación de contraseña enviada a ${user.email}`);
        } catch (err) {
          recordDelivery(user.email, { ok: false, error: (err as Error).message });
          console.error(`[mail] FALLÓ la recuperación de contraseña de ${user.email}:`, err);
        }
      },
    },
    // Sesiones cortas CON rotación: la cookie vive sessionMaxAgeDays (default 2
    // días, antes 7 fijos) y cada sessionUpdateAgeMinutes de uso se renueva la
    // expiración. Así una cookie robada caduca pronto sin obligar a reloguearse
    // a quien usa el gateway a diario.
    session: {
      expiresIn: Math.round(config.sessionMaxAgeDays * 24 * 60 * 60),
      updateAge: Math.round(config.sessionUpdateAgeMinutes * 60),
    },
    advanced: {
      // Behind cloudflared/tailscale the public origin is https even though
      // the local listener is http.
      useSecureCookies: config.baseUrl.startsWith("https://"),
    },
    plugins: [
      mcp({
        loginPage: "/login",
        // RFC 9728: the protected resource is the /mcp endpoint.
        resource: `${config.baseUrl}/mcp`,
        oidcConfig: {
          loginPage: "/login",
          // OAuth 2.1: PKCE obligatorio, solo S256.
          requirePKCE: true,
          allowPlainCodeChallengeMethod: false,
          accessTokenExpiresIn: 3600,
          refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        },
      }),
    ],
  });

  return { auth, db, mailer };
}

/** Create/upgrade the Better Auth schema in SQLite. */
export async function migrate(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
