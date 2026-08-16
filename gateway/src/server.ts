import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  withMcpAuth,
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from "better-auth/plugins";
import type Database from "better-sqlite3";
import { timingSafeEqual } from "node:crypto";
import type { GatewayConfig } from "./env.js";
import type { Auth } from "./auth.js";
import { proxyMcp } from "./proxy.js";
import { landingPageHtml } from "./landing-page.js";
import { loginPageHtml } from "./login-page.js";
import type { TenantRegistry } from "./tenants.js";
import { createProvisioner, slugFromEmail, type Provisioner } from "./provision.js";
import {
  registroPageHtml,
  registroExitoHtml,
  registroErrorProvisionHtml,
  registroCapacidadHtml,
  googleSinInvitacionHtml,
  type VerificationState,
} from "./registro-page.js";
import {
  verificadoPageHtml,
  reenvioVerificacionHtml,
  olvidePasswordHtml,
  olvidePasswordEnviadoHtml,
  restablecerPasswordHtml,
  restablecerTokenInvalidoHtml,
  restablecerOkHtml,
} from "./mail-pages.js";
import { lastDelivery } from "./mailer.js";
import { VERIFY_CALLBACK_PATH, RESET_PASSWORD_PATH } from "./auth.js";
import { createRateLimiter, clientIpFrom } from "./rate-limit.js";
import { consentPageHtml } from "./consent-page.js";
import {
  cuentaPageHtml,
  type CuentaClientView,
  type CuentaSessionView,
} from "./cuenta-page.js";
import { CSRF_FIELD, csrfToken, verifyCsrfToken, isSameOrigin } from "./csrf.js";
import { exportGraph, panelMemoria } from "./export.js";
import { COOKIE_IDIOMA, idiomaDe, type Idioma } from "./i18n.js";
import { guiaPageHtml } from "./guia-page.js";
import {
  REGISTRO_COOKIE_NAME,
  REGISTRO_COOKIE_MAX_AGE,
  registroOkValue,
  verifyRegistroOk,
} from "./registro-token.js";

function safeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Scopes que el plugin MCP acepta; fuera de esto deja decidir a Better Auth. */
const KNOWN_SCOPES = ["openid", "profile", "email", "offline_access"];

/** Parámetros de /authorize que se reenvían tal cual tras el consentimiento. */
const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "nonce",
  "resource",
] as const;

/** Vista mínima del adaptador de Better Auth que necesita el gateway. */
interface MinimalAdapter {
  findOne<T = Record<string, unknown>>(query: {
    model: string;
    where: Array<{ field: string; value: unknown }>;
  }): Promise<T | null>;
  findMany<T = Record<string, unknown>>(query: {
    model: string;
    where?: Array<{ field: string; value: unknown }>;
  }): Promise<T[]>;
  create<T = Record<string, unknown>>(query: {
    model: string;
    data: Record<string, unknown>;
  }): Promise<T>;
  update(query: {
    model: string;
    where: Array<{ field: string; value: unknown }>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  deleteMany(query: {
    model: string;
    where: Array<{ field: string; value: unknown }>;
  }): Promise<number | unknown>;
}

function originOfUri(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return String(value ?? "");
}

export function buildApp(
  auth: Auth,
  config: GatewayConfig,
  db: Database.Database,
  tenants: TenantRegistry,
  provisioner: Provisioner = createProvisioner(config),
): Hono {
  const app = new Hono();

  // --- Cabeceras de seguridad en TODAS las respuestas ---
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("X-Content-Type-Options", "nosniff");
    const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
    const isHttps = forwardedProto === "https" || new URL(c.req.url).protocol === "https:";
    if (isHttps) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  const openCors = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "Accept",
      "Mcp-Session-Id",
      "Mcp-Protocol-Version",
      "Last-Event-Id",
    ],
    exposeHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version", "WWW-Authenticate"],
    maxAge: 600,
  });
  app.use("/.well-known/*", openCors);
  app.use("/mcp", openCors);
  app.use("/mcp/*", openCors);

  // --- OAuth discovery metadata (RFC 8414 / RFC 9728) ---
  const discovery = oAuthDiscoveryMetadata(auth);
  const protectedResource = oAuthProtectedResourceMetadata(auth);
  // Clients may append the resource path to the well-known URL
  // (e.g. /.well-known/oauth-protected-resource/mcp), so match both.
  app.get("/.well-known/oauth-authorization-server", (c) => discovery(c.req.raw));
  app.get("/.well-known/oauth-authorization-server/*", (c) => discovery(c.req.raw));
  app.get("/.well-known/oauth-protected-resource", (c) => protectedResource(c.req.raw));
  app.get("/.well-known/oauth-protected-resource/*", (c) => protectedResource(c.req.raw));

  // --- Gate del sign-up PÚBLICO ---
  // Better Auth tiene el sign-up habilitado internamente (para /registro y los
  // CLIs); el endpoint HTTP abierto solo se permite con ALLOW_SIGNUP=true.
  app.use("/api/auth/sign-up/*", async (c, next) => {
    if (!config.allowSignup) {
      return c.json(
        {
          error: "signup_disabled",
          message:
            "Registro abierto deshabilitado (ALLOW_SIGNUP=false). " +
            "Usa /registro con código de invitación si está habilitado.",
        },
        403,
      );
    }
    return next();
  });

  // --- Rate limit del Dynamic Client Registration (DCR) ---
  // /api/auth/mcp/register es público por diseño (RFC 7591), pero sin límite
  // permite inflar la base SQLite. Cap global modesto por IP; el resto del
  // flujo OAuth no se limita aquí.
  const dcrLimiter = createRateLimiter(config.dcrRateLimit);
  app.use("/api/auth/mcp/register", async (c, next) => {
    if (!dcrLimiter.ok(clientIpFrom(c.req.raw.headers))) {
      return c.json({ error: "too_many_requests" }, 429);
    }
    return next();
  });

  // --- SEGURIDAD: allowlist de redirect_uri (OAuth) ---------------------------
  // El plugin MCP de Better Auth deja que el CLIENTE decida si hay pantalla de
  // consentimiento (`requireConsent: query.prompt === "consent"`), así que un
  // atacante podía: registrar por DCR un cliente con redirect_uri hacia su
  // dominio, mandarle al dueño un enlace a /authorize y —con la cookie de sesión
  // viajando por SameSite=Lax— recibir el `code` en su servidor y canjear un
  // token con acceso total al grafo. Verificado explotable de extremo a extremo.
  // Defensa: solo se admiten redirect_uri de orígenes conocidos (clientes MCP
  // legítimos + loopback para desarrollo). PKCE no protege: el atacante ES el
  // cliente y genera su propio verifier.
  const isAllowedRedirect = (raw: string | null): boolean => {
    if (!raw) return true; // el propio Better Auth valida su ausencia
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) {
      return true; // MCP Inspector / desarrollo local
    }
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return config.allowedRedirectHosts.some(
      (allowed) => host === allowed || host.endsWith("." + allowed),
    );
  };

  const rejectRedirect = (c: Context) =>
    c.json(
      {
        error: "invalid_request",
        error_description:
          "redirect_uri no permitido. Solo se aceptan clientes MCP autorizados.",
      },
      400,
    );

  app.use("/api/auth/mcp/register", async (c, next) => {
    if (c.req.method === "POST") {
      let body: unknown;
      try {
        body = await c.req.raw.clone().json();
      } catch {
        body = null;
      }
      const uris = (body as { redirect_uris?: unknown })?.redirect_uris;
      if (Array.isArray(uris) && !uris.every((u) => isAllowedRedirect(String(u)))) {
        console.warn(
          `[seguridad] DCR rechazado por redirect_uri no permitido: ${JSON.stringify(uris)}`,
        );
        return rejectRedirect(c);
      }
    }
    return next();
  });

  app.use("/api/auth/mcp/authorize", async (c, next) => {
    const uri = new URL(c.req.url).searchParams.get("redirect_uri");
    if (!isAllowedRedirect(uri)) {
      console.warn(`[seguridad] authorize rechazado por redirect_uri no permitido: ${uri}`);
      return rejectRedirect(c);
    }
    return next();
  });

  // --- SEGURIDAD: pantalla de consentimiento PROPIA ---------------------------
  // Defensa en profundidad sobre la allowlist. El plugin MCP pide consentimiento
  // solo si el CLIENTE manda `prompt=consent`, o sea: quien pide el token decide
  // si el dueño ve algo. Aquí lo decide el gateway. Antes de dejar que Better
  // Auth emita un `code`, si hay sesión y no existe consentimiento previo para
  // (usuario, client_id) se muestra la pantalla y NO se llama a Better Auth, así
  // que no se genera ningún código.
  //
  // La petición se deja pasar sin tocar cuando NO es un authorize válido (falta
  // sesión, cliente inexistente, sin PKCE, scope raro...): esos casos los
  // resuelve Better Auth con su propio error, y así este middleware nunca cambia
  // el comportamiento de un flujo que de todos modos iba a fallar.
  const adapterOf = async (): Promise<MinimalAdapter> =>
    (await auth.$context).adapter as unknown as MinimalAdapter;

  const consentGiven = async (userId: string, clientId: string): Promise<boolean> => {
    const adapter = await adapterOf();
    const row = await adapter.findOne<{ consentGiven?: unknown }>({
      model: "oauthConsent",
      where: [
        { field: "userId", value: userId },
        { field: "clientId", value: clientId },
      ],
    });
    return Boolean(row?.consentGiven);
  };

  const authorizeUrl = (params: Record<string, string>) => {
    const qs = new URLSearchParams(params);
    return `/api/auth/mcp/authorize?${qs.toString()}`;
  };

  app.use("/api/auth/mcp/authorize", async (c, next) => {
    if (c.req.method !== "GET") return next();
    const q = new URL(c.req.url).searchParams;

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return next(); // sin sesión: Better Auth manda a /login

    const clientId = q.get("client_id");
    const redirectUri = q.get("redirect_uri");
    if (!clientId || !redirectUri) return next();
    if (q.get("response_type") !== "code") return next();
    // PKCE es obligatorio (requirePKCE); sin él Better Auth debe rechazar.
    if (!q.get("code_challenge") || !q.get("code_challenge_method")) return next();
    const scopes = (q.get("scope") ?? "openid").split(" ").filter(Boolean);
    if (scopes.some((s) => !KNOWN_SCOPES.includes(s))) return next();

    const adapter = await adapterOf();
    const client = await adapter.findOne<{
      name?: string;
      redirectUrls?: string;
      disabled?: unknown;
    }>({
      model: "oauthApplication",
      where: [{ field: "clientId", value: clientId }],
    });
    if (!client || client.disabled) return next();
    const registered = String(client.redirectUrls ?? "").split(",");
    if (!registered.includes(redirectUri)) return next();

    const params: Record<string, string> = {};
    for (const key of AUTHORIZE_PARAMS) {
      const value = q.get(key);
      if (value !== null) params[key] = value;
    }

    if (await consentGiven(session.user.id, clientId)) {
      // Ya autorizó a este cliente: no se le vuelve a preguntar. Si el cliente
      // mandó prompt=consent, se reentra sin él para que Better Auth emita el
      // código directamente (su rama de consentimiento requiere consentPage).
      if (q.get("prompt")) return c.redirect(authorizeUrl(params), 302);
      return next();
    }

    return c.html(
      consentPageHtml({
        clientName: String(client.name ?? clientId),
        redirectOrigin: originOfUri(redirectUri),
        userEmail: session.user.email,
        scopes,
        csrf: csrfToken(session.user.id, config.authSecret),
        params,
      }),
    );
  });

  // Decisión del usuario en la pantalla de consentimiento.
  app.post("/consentimiento", async (c) => {
    if (!isSameOrigin(c.req.raw, config.baseUrl)) {
      return c.text("Petición cross-origin rechazada.", 403);
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.redirect("/login", 302);

    const body = await c.req.parseBody();
    if (!verifyCsrfToken(body[CSRF_FIELD], session.user.id, config.authSecret)) {
      return c.html(
        errorHtml(
          "La página había caducado",
          "Por seguridad verificamos que la acción venga de una pestaña actualizada. " +
            "Vuelve a tu cuenta y repite la acción.",
        ),
        403,
      );
    }

    const params: Record<string, string> = {};
    for (const key of AUTHORIZE_PARAMS) {
      const value = body[`p_${key}`];
      if (typeof value === "string" && value.length > 0) params[key] = value;
    }
    const clientId = params["client_id"];
    const redirectUri = params["redirect_uri"];
    if (!clientId || !redirectUri) return c.text("Solicitud incompleta.", 400);
    // El redirect_uri vuelve del formulario: se revalida contra la allowlist y
    // contra los URIs registrados del cliente antes de redirigir a ninguna parte.
    if (!isAllowedRedirect(redirectUri)) return rejectRedirect(c);

    const adapter = await adapterOf();
    const client = await adapter.findOne<{ redirectUrls?: string; disabled?: unknown }>({
      model: "oauthApplication",
      where: [{ field: "clientId", value: clientId }],
    });
    if (!client || client.disabled) return c.text("Cliente OAuth desconocido.", 400);
    if (!String(client.redirectUrls ?? "").split(",").includes(redirectUri)) {
      return rejectRedirect(c);
    }

    if (String(body["decision"] ?? "") !== "autorizar") {
      const denied = new URL(redirectUri);
      denied.searchParams.set("error", "access_denied");
      denied.searchParams.set("error_description", "El usuario denegó el acceso");
      if (params["state"]) denied.searchParams.set("state", params["state"]);
      return c.redirect(denied.toString(), 302);
    }

    const scopes = (params["scope"] ?? "openid").split(" ").filter(Boolean).join(" ");
    const existing = await adapter.findOne<{ id: string }>({
      model: "oauthConsent",
      where: [
        { field: "userId", value: session.user.id },
        { field: "clientId", value: clientId },
      ],
    });
    if (existing) {
      await adapter.update({
        model: "oauthConsent",
        where: [{ field: "id", value: existing.id }],
        update: { scopes, consentGiven: true, updatedAt: new Date() },
      });
    } else {
      await adapter.create({
        model: "oauthConsent",
        data: {
          clientId,
          userId: session.user.id,
          scopes,
          consentGiven: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
    // Con el consentimiento registrado, el mismo middleware deja pasar la
    // petición y Better Auth emite el código.
    return c.redirect(authorizeUrl(params), 302);
  });

  // --- Better Auth: login, OAuth authorize/token/register (DCR), sessions ---
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // --- Login page (single owner, Spanish) ---
  const mode = config.registrationMode;
  const registrationEnabled = () => mode !== "closed";
  // Google es opcional: sin AMBAS credenciales, no hay botón ni proveedor.
  const googleEnabled = Boolean(config.googleClientId && config.googleClientSecret);
  const secureCookies = config.baseUrl.startsWith("https://");
  app.get("/login", (c) =>
    c.html(
      loginPageHtml({
        showRegisterLink: registrationEnabled(),
        openRegistration: mode === "open",
        showGoogle: googleEnabled,
      }),
    ),
  );
  app.get("/", (c) => c.html(landingPageHtml(config.baseUrl, mode)));
  app.get("/health", (c) => c.json({ ok: true }));

  // --- VÁLVULA DE SEGURIDAD: tope duro de tenants (MAX_TENANTS) --------------
  // El MCP de cada tenant corre con MemoryMax=500M y el servidor tiene ~1 GB de
  // RAM libre, compartida con las apps de producción del dueño. Un registro
  // abierto sin tope puede dejar la máquina sin memoria (OOM), así que se
  // comprueba ANTES de crear la cuenta: si está lleno no se crea usuario, no se
  // aprovisiona nada y se muestra la página de capacidad.
  const atCapacity = (): boolean => {
    try {
      return tenants.count() >= config.maxTenants;
    } catch (err) {
      // tenants.json ilegible: se prefiere NO registrar antes que arriesgar el
      // tope. El error queda en el log.
      console.error("[registro] no se pudo contar los tenants:", err);
      return true;
    }
  };

  const refuseForCapacity = (c: Context, who: string) => {
    console.warn(
      `[registro] RECHAZADO por capacidad (MAX_TENANTS=${config.maxTenants}): ${who}`,
    );
    return c.html(registroCapacidadHtml(), 503);
  };

  // --- Registro self-service (/registro) ---
  app.get("/registro", (c) =>
    c.html(
      registroPageHtml({ mode, showGoogle: googleEnabled }),
      mode === "closed" ? 403 : 200,
    ),
  );

  // Rate limit en memoria para POST /registro: registroRateLimit req/min/IP.
  // La IP se toma del salto de confianza (cf-connecting-ip o el ÚLTIMO valor
  // de X-Forwarded-For), nunca del primero (controlado por el cliente).
  const registroLimiter = createRateLimiter(config.registroRateLimit);

  /**
   * Borra por completo un usuario recién creado (cuenta de credenciales y
   * sesiones incluidas). Se usa cuando el aprovisionamiento falla: así el
   * correo no queda "quemado" —un reintento con el mismo correo funciona— y no
   * queda una cuenta que inicia sesión pero no tiene memoria detrás.
   */
  const deleteUserByEmail = async (email: string): Promise<void> => {
    const adapter = await adapterOf();
    const user = await adapter.findOne<{ id: string }>({
      model: "user",
      where: [{ field: "email", value: email }],
    });
    if (!user?.id) return;
    for (const model of ["session", "account"]) {
      await adapter.deleteMany({ model, where: [{ field: "userId", value: user.id }] });
    }
    await adapter.deleteMany({ model: "user", where: [{ field: "id", value: user.id }] });
  };

  app.post("/registro", async (c) => {
    const ip = clientIpFrom(c.req.raw.headers);
    if (!registroLimiter.ok(ip)) {
      return c.text("Demasiados intentos. Espera un minuto y vuelve a intentarlo.", 429);
    }
    if (mode === "closed") {
      return c.html(registroPageHtml({ mode: "closed" }), 403);
    }

    const body = await c.req.parseBody();
    const email = String(body["email"] ?? "").trim().toLowerCase();
    const password = String(body["password"] ?? "");
    const confirm = String(body["confirm"] ?? "");
    const code = String(body["code"] ?? "");

    const fail = (error: string, status: 400 | 403 = 400) =>
      c.html(registroPageHtml({ mode, error, email, showGoogle: googleEnabled }), status);

    if (mode === "invite" && !safeEquals(code, config.registrationCode)) {
      return fail("Código de invitación incorrecto.", 403);
    }
    if (!EMAIL_RE.test(email)) return fail("Correo inválido.");
    if (password.length < 10) return fail("La contraseña debe tener al menos 10 caracteres.");
    if (password !== confirm) return fail("Las contraseñas no coinciden.");

    // Tope de capacidad ANTES de tocar la base: ni usuario ni tenant.
    if (atCapacity()) return refuseForCapacity(c, email);

    // 1) Crear el usuario (server-side; funciona aunque ALLOW_SIGNUP=false).
    //    El alta dispara el correo de verificación (emailVerification.sendOnSignUp);
    //    el callback nunca lanza, así que un fallo de correo NO rompe el alta.
    try {
      await auth.api.signUpEmail({
        body: {
          email,
          password,
          name: email.split("@")[0] ?? email,
          callbackURL: VERIFY_CALLBACK_PATH,
        },
      });
    } catch (err) {
      // Mensaje NEUTRO: no distinguir "correo ya registrado" de otros fallos
      // para no permitir enumeración de cuentas. El detalle queda en el log.
      console.error(`[registro] fallo creando usuario ${email}:`, err);
      return fail("No se pudo crear la cuenta. Verifica los datos e inténtalo de nuevo.");
    }

    // 2) Aprovisionar su tenant (slug + puerto + contenedor) y mapearlo.
    try {
      const result = await provisioner.provision(email);
      tenants.setMapping(email, result.upstreamUrl, result.slug);
      console.log(
        `[registro] tenant listo: ${email} -> ${result.upstreamUrl} (slug=${result.slug})`,
      );
      // El aprovisionamiento ya está hecho y NO se deshace por un fallo de
      // correo: si la verificación no salió, la página lo dice y ofrece
      // reenviar, en vez de dejar a la persona con un 500 y una cuenta a medias.
      const delivery = lastDelivery(email);
      const verification: VerificationState = delivery?.ok ? "enviado" : "pendiente";
      if (!delivery?.ok) {
        console.warn(
          `[registro] cuenta y tenant OK pero SIN correo de verificación para ${email}` +
            (delivery?.error ? `: ${delivery.error}` : " (correo deshabilitado)"),
        );
      }
      return c.html(registroExitoHtml(config.baseUrl, email, verification));
    } catch (err) {
      console.error(`[registro] fallo aprovisionando tenant para ${email}:`, err);
      // Rollback: la cuenta recién creada se borra para no dejar un usuario
      // que entra pero no tiene memoria (y para que el correo siga libre).
      try {
        await deleteUserByEmail(email);
        console.warn(`[registro] rollback: usuario ${email} borrado tras fallo de provisión`);
      } catch (cleanupErr) {
        console.error(`[registro] rollback FALLÓ para ${email}:`, cleanupErr);
      }
      return c.html(registroErrorProvisionHtml(email), 500);
    }
  });

  // --- Validación del código de invitación para el registro vía Google ---
  // Emite la cookie httpOnly `registro_ok` (HMAC del código) SOLO si el código
  // es correcto. /post-google exige esta cookie para aprovisionar a un usuario
  // nuevo autenticado con Google. Reutiliza el mismo rate limit que /registro.
  app.post("/registro/validar-codigo", async (c) => {
    const ip = clientIpFrom(c.req.raw.headers);
    if (!registroLimiter.ok(ip)) {
      return c.json({ error: "too_many_requests" }, 429);
    }
    // Solo tiene sentido en modo `invite`: en `open` no hay código que validar
    // y en `closed` no se registra nadie.
    if (mode !== "invite") {
      return c.json({ error: "registro_deshabilitado" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    const code = String(body.code ?? "");
    if (!safeEquals(code, config.registrationCode)) {
      return c.json({ ok: false }, 403);
    }
    setCookie(c, REGISTRO_COOKIE_NAME, registroOkValue(config.registrationCode, config.authSecret), {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookies,
      path: "/",
      maxAge: REGISTRO_COOKIE_MAX_AGE,
    });
    return c.json({ ok: true });
  });

  // --- Correo: verificación y recuperación de contraseña ---------------------
  // Todo lo que dispara un envío comparte un rate limit por IP: son las rutas
  // que un abusador usaría para bombardear el buzón de otra persona (o para
  // quemar la cuota de Resend). Las respuestas son NEUTRAS: nunca dicen si una
  // dirección existe, para no convertir el formulario en un enumerador.
  const mailLimiter = createRateLimiter(config.mailRateLimit);

  const sessionViewOf = async (c: Context) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    return session?.user
      ? {
          email: session.user.email,
          csrf: csrfToken(session.user.id, config.authSecret),
        }
      : null;
  };

  // Aterrizaje del enlace del correo. Better Auth verifica el token en
  // /api/auth/verify-email y redirige aquí; si algo falla, añade ?error=CÓDIGO.
  app.get(VERIFY_CALLBACK_PATH, async (c) =>
    c.html(
      verificadoPageHtml({
        session: await sessionViewOf(c),
        error: c.req.query("error") ?? null,
      }),
      c.req.query("error") ? 400 : 200,
    ),
  );

  /**
   * Reenvío de la verificación SIN sesión (lo usa la página de "verificación
   * pendiente" del registro y la de enlace caducado). Responde siempre lo
   * mismo, exista o no la cuenta.
   */
  app.post("/reenviar-verificacion", async (c) => {
    if (!mailLimiter.ok(clientIpFrom(c.req.raw.headers))) {
      return c.text("Demasiados intentos. Espera un minuto y vuelve a intentarlo.", 429);
    }
    const body = await c.req.parseBody();
    const email = String(body["email"] ?? "").trim().toLowerCase();
    if (EMAIL_RE.test(email)) {
      try {
        await auth.api.sendVerificationEmail({
          body: { email, callbackURL: VERIFY_CALLBACK_PATH },
        });
      } catch (err) {
        // Incluye "ya verificado" y "no existe": no se distinguen hacia fuera.
        console.warn(`[mail] reenvío de verificación sin efecto para ${email}:`, err);
      }
    }
    return c.html(reenvioVerificacionHtml());
  });

  // --- Recuperación de contraseña --------------------------------------------
  app.get("/olvide-password", (c) => c.html(olvidePasswordHtml()));

  app.post("/olvide-password", async (c) => {
    if (!mailLimiter.ok(clientIpFrom(c.req.raw.headers))) {
      return c.text("Demasiados intentos. Espera un minuto y vuelve a intentarlo.", 429);
    }
    const body = await c.req.parseBody();
    const email = String(body["email"] ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return c.html(olvidePasswordHtml({ error: "Correo inválido.", email }), 400);
    }
    try {
      await auth.api.requestPasswordReset({
        body: { email, redirectTo: RESET_PASSWORD_PATH },
      });
    } catch (err) {
      // Un fallo aquí (correo caído, Resend con errores) no debe delatar nada
      // ni devolver un 500: queda en el log y la respuesta es la misma.
      console.error(`[mail] fallo pidiendo recuperación para ${email}:`, err);
    }
    return c.html(olvidePasswordEnviadoHtml());
  });

  app.get(RESET_PASSWORD_PATH, (c) => {
    const token = c.req.query("token") ?? "";
    // Better Auth redirige aquí con ?error=INVALID_TOKEN cuando el enlace ya no
    // vale; sin token no hay nada que hacer tampoco.
    if (c.req.query("error") || !token) {
      return c.html(restablecerTokenInvalidoHtml(), 400);
    }
    return c.html(restablecerPasswordHtml({ token }));
  });

  app.post(RESET_PASSWORD_PATH, async (c) => {
    if (!mailLimiter.ok(clientIpFrom(c.req.raw.headers))) {
      return c.text("Demasiados intentos. Espera un minuto y vuelve a intentarlo.", 429);
    }
    const body = await c.req.parseBody();
    const token = String(body["token"] ?? "");
    const password = String(body["password"] ?? "");
    const confirm = String(body["confirm"] ?? "");
    if (!token) return c.html(restablecerTokenInvalidoHtml(), 400);
    if (password.length < 10) {
      return c.html(
        restablecerPasswordHtml({
          token,
          error: "La contraseña debe tener al menos 10 caracteres.",
        }),
        400,
      );
    }
    if (password !== confirm) {
      return c.html(
        restablecerPasswordHtml({ token, error: "Las contraseñas no coinciden." }),
        400,
      );
    }
    try {
      await auth.api.resetPassword({ body: { token, newPassword: password } });
    } catch (err) {
      console.warn("[mail] restablecimiento rechazado:", err);
      return c.html(restablecerTokenInvalidoHtml(), 400);
    }
    console.log("[cuenta] contraseña restablecida con un enlace de correo");
    return c.html(restablecerOkHtml());
  });

  /** Cierra la sesión actual y devuelve `html` con `status` (cookies borradas). */
  const signOutWith = async (c: Context, html: string, status: 403 | 503) => {
    const signOut = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
    const response = new Response(html, {
      status,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
    for (const setCookieHeader of signOut.headers.getSetCookie()) {
      response.headers.append("set-cookie", setCookieHeader);
    }
    return response;
  };

  // --- Post-callback de Google: HACE CUMPLIR el modo de registro ---
  // El callback de Better Auth (/api/auth/callback/google) redirige aquí. En
  // este punto el usuario YA está autenticado (sesión creada). Reglas:
  //   - Usuario con tenant mapeado -> login normal (reanuda OAuth si aplica).
  //   - Usuario sin tenant, según REGISTRATION_MODE:
  //       · `open`   -> aprovisiona y mapea (rate limit + tope MAX_TENANTS).
  //       · `invite` -> solo con cookie `registro_ok` válida; si no, se cierra
  //                     la sesión y se pide un código de invitación.
  //       · `closed` -> nunca aprovisiona; se cierra la sesión.
  // Invariante: un usuario sin mapeo sigue recibiendo 403 en /mcp.
  app.get("/post-google", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.redirect("/login");

    const email = session.user.email;
    const userId = session.user.id;
    const resume = c.req.query("resume");
    // Reanuda el flujo OAuth original (si lo hubo) o muestra "sesión iniciada".
    const done = () => {
      if (resume && resume.length > 1) {
        const qs = resume.startsWith("?") ? resume : `?${resume}`;
        return c.redirect(`/api/auth/mcp/authorize${qs}`);
      }
      // Sin flujo OAuth que reanudar, entrar directo al panel: mostrar una
      // pantalla intermedia de "ya puedes cerrar" era un paso de mas. /cuenta
      // ya indica si el correo esta pendiente de verificar.
      return c.redirect("/cuenta", 302);
    };

    const upstream = tenants.resolveUpstream(userId, email);
    if (upstream) return done(); // usuario existente: login normal

    // Registro cerrado: nadie nuevo entra por Google.
    if (mode === "closed") {
      console.warn(`[google] sesión sin tenant con registro cerrado: ${email} — cerrando sesión`);
      return signOutWith(c, registroPageHtml({ mode: "closed" }), 403);
    }

    // Alta de un usuario nuevo por Google: mismo rate limit por IP que /registro.
    const ip = clientIpFrom(c.req.raw.headers);
    if (!registroLimiter.ok(ip)) {
      console.warn(`[google] rate limit alcanzado en el alta por Google desde ${ip}`);
      return c.text("Demasiados intentos. Espera un minuto y vuelve a intentarlo.", 429);
    }

    // En modo `invite` sigue haciendo falta la cookie `registro_ok`; en `open`
    // el alta procede directamente.
    const cookie = getCookie(c, REGISTRO_COOKIE_NAME);
    const invited =
      mode === "open" ||
      verifyRegistroOk(cookie, config.registrationCode, config.authSecret);

    if (!invited) {
      // Sin cookie válida: NO aprovisionar. Cierra la sesión y explica.
      console.warn(`[google] sesión sin tenant ni invitación válida: ${email} — cerrando sesión`);
      return signOutWith(c, googleSinInvitacionHtml(), 403);
    }

    // Tope de capacidad: se comprueba también aquí (misma válvula que /registro).
    if (atCapacity()) {
      console.warn(
        `[google] alta RECHAZADA por capacidad (MAX_TENANTS=${config.maxTenants}): ${email}`,
      );
      return signOutWith(c, registroCapacidadHtml(), 503);
    }

    try {
      const result = await provisioner.provision(email);
      tenants.setMapping(email, result.upstreamUrl, result.slug);
      deleteCookie(c, REGISTRO_COOKIE_NAME, { path: "/" });
      console.log(
        `[google] tenant listo: ${email} -> ${result.upstreamUrl} (slug=${result.slug})`,
      );
      return done();
    } catch (err) {
      console.error(`[google] fallo aprovisionando tenant para ${email}:`, err);
      // Mismo rollback que en /registro: se borra el usuario recién creado para
      // no dejar una cuenta que entra pero no tiene memoria.
      try {
        await deleteUserByEmail(email);
        console.warn(`[google] rollback: usuario ${email} borrado tras fallo de provisión`);
      } catch (cleanupErr) {
        console.error(`[google] rollback FALLÓ para ${email}:`, cleanupErr);
      }
      return c.html(registroErrorProvisionHtml(email), 500);
    }
  });

  // --- Panel de cuenta (/cuenta) y exportación (/export) ----------------------
  // Ambas rutas exigen sesión de navegador (no bearer): son superficie de
  // usuario, no de la API MCP.
  const requireSession = async (c: Context) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    return session?.user ? session : null;
  };

  /** Clientes OAuth que este usuario autorizó (consentimiento o token vivo). */
  // Página de error simple pero presentable: estos fallos los ve una persona en
  // su navegador, no un cliente de API.
  const errorHtml = (titulo: string, detalle: string, volverA = "/cuenta") =>
    `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${titulo} — Second Brain</title><style>` +
    `:root{color-scheme:light dark}body{font-family:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;` +
    `display:grid;place-items:center;min-height:100vh;margin:0;background:Canvas;color:CanvasText;line-height:1.55}` +
    `.card{width:min(28rem,calc(100vw - 2rem));border:1px solid color-mix(in oklab,CanvasText 15%,transparent);` +
    `border-radius:12px;padding:1.75rem;background:color-mix(in oklab,Canvas 92%,CanvasText 8%)}` +
    `h1{margin:0 0 .5rem;font-size:1.2rem}p{margin:0 0 1rem;color:color-mix(in oklab,CanvasText 70%,transparent)}` +
    `a{display:inline-block;padding:.55rem .95rem;border-radius:8px;background:#4f46e5;color:#fff;` +
    `text-decoration:none;font-size:.95rem}</style></head><body><main class="card">` +
    `<h1>${titulo}</h1><p>${detalle}</p><a href="${volverA}">Volver</a></main></body></html>`;

  const clientsOf = async (userId: string): Promise<CuentaClientView[]> => {
    const adapter = await adapterOf();
    const consents = await adapter.findMany<{
      clientId: string;
      createdAt: unknown;
    }>({ model: "oauthConsent", where: [{ field: "userId", value: userId }] });
    const tokens = await adapter.findMany<{ clientId: string }>({
      model: "oauthAccessToken",
      where: [{ field: "userId", value: userId }],
    });

    const ids = new Set<string>([
      ...consents.map((r) => r.clientId),
      ...tokens.map((r) => r.clientId),
    ]);
    const views: CuentaClientView[] = [];
    for (const clientId of ids) {
      const app = await adapter.findOne<{ name?: string; redirectUrls?: string }>({
        model: "oauthApplication",
        where: [{ field: "clientId", value: clientId }],
      });
      const consent = consents.find((r) => r.clientId === clientId);
      views.push({
        clientId,
        name: String(app?.name ?? clientId),
        redirectOrigins: [
          ...new Set(
            String(app?.redirectUrls ?? "")
              .split(",")
              .filter(Boolean)
              .map(originOfUri),
          ),
        ],
        authorizedAt: consent ? toIso(consent.createdAt) : null,
        activeTokens: tokens.filter((t) => t.clientId === clientId).length,
      });
    }
    return views;
  };

  const renderCuenta = async (c: Context, notice: string | null) => {
    const session = await requireSession(c);
    if (!session) return c.redirect("/login", 302);
    const adapter = await adapterOf();
    const rows = await adapter.findMany<{
      id: string;
      createdAt: unknown;
      updatedAt: unknown;
      ipAddress: string | null;
      userAgent: string | null;
    }>({ model: "session", where: [{ field: "userId", value: session.user.id }] });
    const sessions: CuentaSessionView[] = rows
      .map((r) => ({
        id: r.id,
        createdAt: toIso(r.createdAt),
        lastUsed: toIso(r.updatedAt),
        ipAddress: r.ipAddress ?? null,
        userAgent: r.userAgent ?? null,
        current: r.id === session.session.id,
      }))
      .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));

    const entrada = tenants.resolveTenant(session.user.id, session.user.email);
    // El resumen y la búsqueda salen del MCP del propio usuario. Si el upstream
    // no responde, se omiten: la página de cuenta debe seguir funcionando.
    const consulta = (c.req.query("q") ?? "").trim();
    const entidad = (c.req.query("entidad") ?? "").trim();
    // Una sola sesión MCP para todo el panel: antes eran tres handshakes.
    const panel = entrada?.url
      ? await panelMemoria(entrada.url, { consulta, entidad })
      : { resumen: null, datos: [], entidades: [], constelacion: null };
    return c.html(
      cuentaPageHtml({
        idioma: idiomaDeC(c),
        url: c.req.path + (c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""),
        resumen: panel.resumen,
        constelacion: panel.constelacion,
        busqueda: consulta
          ? { consulta, datos: panel.datos, entidades: panel.entidades }
          : null,
        email: session.user.email,
        emailVerified: Boolean(session.user.emailVerified),
        upstream: entrada?.url ?? null,
        tenant: entrada?.slug ?? slugFromEmail(session.user.email),
        mcpUrl: `${config.baseUrl.replace(/\/$/, "")}/mcp`,
        sessions,
        clients: await clientsOf(session.user.id),
        csrf: csrfToken(session.user.id, config.authSecret),
        notice,
      }),
    );
  };

  const NOTICES: Record<string, string> = {
    "cliente-revocado": "Aplicación revocada: se borraron su consentimiento y sus tokens.",
    "sesiones-cerradas": "Se cerraron todas las demás sesiones.",
    "verificacion-enviada":
      "Te enviamos un correo de verificación. Revisa la bandeja de entrada y el spam.",
    "verificacion-fallo":
      "No pudimos enviar el correo de verificación ahora mismo. Vuelve a intentarlo en unos minutos.",
  };

  app.get("/cuenta", (c) => renderCuenta(c, NOTICES[c.req.query("ok") ?? ""] ?? null));

  // La guía es PÚBLICA: es documentación (todo está en el repo público) y se
  // enlaza desde la landing, así que exigir sesión solo rebotaba al login a
  // quien todavía no tiene cuenta. No contiene secretos: los comandos usan
  // marcadores (<password del tenant>, <key>).
  // Se renderiza dentro del MISMO shell que /cuenta: con sesión la barra trae
  // el correo y "Cerrar sesión"; sin sesión, "Iniciar sesión".
  // Página de "sesión iniciada" con estilo, compartida por el login por correo
  // y por el retorno de Google cuando no hay flujo OAuth que reanudar.
  // Se conserva por compatibilidad con enlaces antiguos: ahora lleva al panel.
  app.get("/sesion-iniciada", (c) => c.redirect("/cuenta", 302));

  // Instalador del CLI. Se sirve desde el propio gateway para que la
  // instruccion sea una sola linea contra el mismo host que el usuario ya
  // conoce: curl -fsSL https://<host>/install.sh | sh
  app.get("/install.sh", (c) => {
    // Se buscan varias rutas porque el layout del repo y el del servidor no
    // coinciden: en el repo el script vive en scripts/, y el despliegue nativo
    // copia los fuentes del gateway a /opt/.../gateway sin esa carpeta.
    const candidatos = [
      path.join(import.meta.dirname, "install.sh"),
      path.join(import.meta.dirname, "..", "install.sh"),
      path.join(import.meta.dirname, "..", "..", "scripts", "install.sh"),
      path.join(import.meta.dirname, "..", "..", "..", "scripts", "install.sh"),
    ];
    for (const ruta of candidatos) {
      try {
        const script = fs.readFileSync(ruta, "utf8");
        return c.text(script, 200, {
          "Content-Type": "text/x-shellscript; charset=utf-8",
          "Cache-Control": "no-cache",
        });
      } catch {
        /* siguiente candidato */
      }
    }
    console.error(`[install.sh] no encontrado en: ${candidatos.join(", ")}`);
    return c.text(
      "# El instalador no esta disponible en este servidor.\n" +
        "# Instalacion manual: https://github.com/jpreyestCL/secondbrain#readme\n",
      503,
      { "Content-Type": "text/x-shellscript; charset=utf-8" },
    );
  });

  /**
   * Idioma de la petición, y se recuerda en cookie.
   *
   * Sin la cookie, cambiar de idioma solo duraría esa página: cada enlace
   * interno volvería al español y el selector parecería roto.
   */
  const idiomaDeC = (c: Context): Idioma => {
    const query = c.req.query("lang") ?? null;
    const idioma = idiomaDe({
      query,
      cookie: getCookie(c, COOKIE_IDIOMA) ?? null,
      acceptLanguage: c.req.header("accept-language") ?? null,
    });
    if (query && query === idioma) {
      setCookie(c, COOKIE_IDIOMA, idioma, {
        path: "/",
        httpOnly: false,
        sameSite: "Lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    return idioma;
  };

  app.get("/guia", async (c) => {
    const session = await requireSession(c);
    const entrada = session
      ? tenants.resolveTenant(session.user.id, session.user.email)
      : null;
    return c.html(
      guiaPageHtml({
        idioma: idiomaDeC(c),
        url: c.req.path + (c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""),
        baseUrl: config.baseUrl,
        // Con sesion, los ejemplos salen con el tenant real ya escrito. El slug
        // guardado manda; el derivado del correo es el respaldo para los mapeos
        // antiguos, anteriores a que se guardara.
        tenant: session ? (entrada?.slug ?? slugFromEmail(session.user.email)) : null,
        session: session
          ? {
              email: session.user.email,
              csrf: csrfToken(session.user.id, config.authSecret),
            }
          : null,
      }),
    );
  });

  /** Guardia común de los POST del panel: same-origin + token CSRF + sesión. */
  const guardedPost = async (c: Context) => {
    if (!isSameOrigin(c.req.raw, config.baseUrl)) {
      return { error: c.text("Petición cross-origin rechazada.", 403) } as const;
    }
    const session = await requireSession(c);
    if (!session) return { error: c.redirect("/login", 302) } as const;
    const body = await c.req.parseBody();
    if (!verifyCsrfToken(body[CSRF_FIELD], session.user.id, config.authSecret)) {
      return {
        error: c.html(
          errorHtml(
            "La página había caducado",
            "Por seguridad verificamos que la acción venga de una pestaña actualizada. " +
              "Vuelve a tu cuenta y repite la acción.",
          ),
          403,
        ),
      } as const;
    }
    return { session, body } as const;
  };

  // "Cerrar sesión" de la barra del dashboard. Es un POST protegido igual que
  // el resto de acciones de /cuenta (same-origin + CSRF): un GET permitiría que
  // cualquier <img src="/logout"> ajeno te desconectara.
  app.post("/cuenta/cerrar-sesion", async (c) => {
    const guard = await guardedPost(c);
    if ("error" in guard) return guard.error;
    const signOut = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
    const response = new Response(null, { status: 302, headers: { location: "/" } });
    for (const setCookieHeader of signOut.headers.getSetCookie()) {
      response.headers.append("set-cookie", setCookieHeader);
    }
    return response;
  });

  // Reenvío de la verificación DESDE el panel (con sesión y CSRF). A diferencia
  // del reenvío público, aquí sí se le dice a la persona si salió o no: es su
  // propia cuenta, no hay nada que enumerar.
  app.post("/cuenta/reenviar-verificacion", async (c) => {
    const guard = await guardedPost(c);
    if ("error" in guard) return guard.error;
    const email = guard.session.user.email;
    if (!mailLimiter.ok(clientIpFrom(c.req.raw.headers))) {
      return c.text("Demasiados intentos. Espera un minuto y vuelve a intentarlo.", 429);
    }
    if (guard.session.user.emailVerified) return c.redirect("/cuenta", 302);
    try {
      await auth.api.sendVerificationEmail({
        headers: c.req.raw.headers,
        body: { email, callbackURL: VERIFY_CALLBACK_PATH },
      });
    } catch (err) {
      console.error(`[mail] reenvío de verificación falló para ${email}:`, err);
      return c.redirect("/cuenta?ok=verificacion-fallo", 302);
    }
    // El callback de envío no lanza; el resultado real está en el registro.
    const delivery = lastDelivery(email);
    return c.redirect(
      delivery?.ok ? "/cuenta?ok=verificacion-enviada" : "/cuenta?ok=verificacion-fallo",
      302,
    );
  });

  app.post("/cuenta/cerrar-sesiones", async (c) => {
    const guard = await guardedPost(c);
    if ("error" in guard) return guard.error;
    const adapter = await adapterOf();
    const rows = await adapter.findMany<{ id: string }>({
      model: "session",
      where: [{ field: "userId", value: guard.session.user.id }],
    });
    for (const row of rows) {
      if (row.id === guard.session.session.id) continue;
      await adapter.deleteMany({ model: "session", where: [{ field: "id", value: row.id }] });
    }
    return c.redirect("/cuenta?ok=sesiones-cerradas", 302);
  });

  app.post("/cuenta/revocar-cliente", async (c) => {
    const guard = await guardedPost(c);
    if ("error" in guard) return guard.error;
    const clientId = String(guard.body["client_id"] ?? "");
    if (!clientId) return c.text("Falta client_id.", 400);
    const userId = guard.session.user.id;
    const adapter = await adapterOf();
    // Solo se tocan las filas de ESTE usuario.
    await adapter.deleteMany({
      model: "oauthConsent",
      where: [
        { field: "userId", value: userId },
        { field: "clientId", value: clientId },
      ],
    });
    await adapter.deleteMany({
      model: "oauthAccessToken",
      where: [
        { field: "userId", value: userId },
        { field: "clientId", value: clientId },
      ],
    });
    // Los clientes se registran por DCR y son de un solo uso/usuario: si ya no
    // le quedan consentimientos ni tokens a nadie, se borra también el registro.
    const restConsents = await adapter.findMany({
      model: "oauthConsent",
      where: [{ field: "clientId", value: clientId }],
    });
    const restTokens = await adapter.findMany({
      model: "oauthAccessToken",
      where: [{ field: "clientId", value: clientId }],
    });
    if (restConsents.length === 0 && restTokens.length === 0) {
      await adapter.deleteMany({
        model: "oauthApplication",
        where: [{ field: "clientId", value: clientId }],
      });
    }
    console.log(`[cuenta] cliente OAuth revocado por ${guard.session.user.email}: ${clientId}`);
    return c.redirect("/cuenta?ok=cliente-revocado", 302);
  });

  app.get("/export", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      // Navegador -> a iniciar sesión; cliente de API -> 401 explícito.
      if ((c.req.header("accept") ?? "").includes("text/html")) {
        return c.redirect("/login", 302);
      }
      return c.json({ error: "unauthorized", message: "Inicia sesión para exportar." }, 401);
    }
    const upstream = tenants.resolveUpstream(session.user.id, session.user.email);
    if (!upstream) {
      return c.json(
        {
          error: "sin_tenant",
          message:
            "Tu cuenta todavía no tiene un servidor de memoria asignado, así que no hay nada que exportar.",
        },
        409,
      );
    }
    const data = await exportGraph(
      upstream,
      { id: session.user.id, email: session.user.email },
      { maxEpisodes: config.exportMaxEpisodes, maxNodes: config.exportMaxNodes },
    );
    const stamp = new Date().toISOString().slice(0, 10);
    c.header("Content-Disposition", `attachment; filename="secondbrain-${stamp}.json"`);
    c.header("Cache-Control", "no-store");
    return c.json(data);
  });

  // --- Protected MCP endpoint ---
  // 1. withMcpAuth validates the bearer token.
  // 2. The session's user is resolved to THEIR upstream via the tenant
  //    registry (userId first, then email). There is NO default upstream:
  //    an unmapped user gets 403, never someone else's graph.
  const emailStmt = db.prepare('SELECT email FROM "user" WHERE id = ?');
  const mcpHandler = withMcpAuth(auth, async (req, session) => {
    const row = emailStmt.get(session.userId) as { email: string } | undefined;
    const upstream = tenants.resolveUpstream(session.userId, row?.email ?? null);
    if (!upstream) {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32003,
            message:
              "Usuario autenticado pero sin tenant asignado. " +
              "Pide al administrador que agregue tu upstream en tenants.json.",
          },
        },
        { status: 403 },
      );
    }
    return proxyMcp(upstream, req);
  });
  app.on(["GET", "POST", "DELETE"], "/mcp", (c) => mcpHandler(c.req.raw));

  return app;
}
