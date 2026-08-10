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
import { createProvisioner, type Provisioner } from "./provision.js";
import {
  registroPageHtml,
  registroExitoHtml,
  registroErrorProvisionHtml,
  googleSinInvitacionHtml,
} from "./registro-page.js";
import { createRateLimiter, clientIpFrom } from "./rate-limit.js";
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

  // --- Better Auth: login, OAuth authorize/token/register (DCR), sessions ---
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // --- Login page (single owner, Spanish) ---
  const registrationEnabled = () => config.registrationCode.length > 0;
  // Google es opcional: sin AMBAS credenciales, no hay botón ni proveedor.
  const googleEnabled = Boolean(config.googleClientId && config.googleClientSecret);
  const secureCookies = config.baseUrl.startsWith("https://");
  app.get("/login", (c) =>
    c.html(loginPageHtml({ showRegisterLink: registrationEnabled(), showGoogle: googleEnabled })),
  );
  app.get("/", (c) => c.html(landingPageHtml(config.baseUrl)));
  app.get("/health", (c) => c.json({ ok: true }));

  // --- Registro self-service con código de invitación (/registro) ---
  app.get("/registro", (c) => {
    const enabled = registrationEnabled();
    return c.html(
      registroPageHtml({ enabled, showGoogle: googleEnabled }),
      enabled ? 200 : 403,
    );
  });

  // Rate limit en memoria para POST /registro: registroRateLimit req/min/IP.
  // La IP se toma del salto de confianza (cf-connecting-ip o el ÚLTIMO valor
  // de X-Forwarded-For), nunca del primero (controlado por el cliente).
  const registroLimiter = createRateLimiter(config.registroRateLimit);

  app.post("/registro", async (c) => {
    const ip = clientIpFrom(c.req.raw.headers);
    if (!registroLimiter.ok(ip)) {
      return c.text("Demasiados intentos. Espera un minuto y vuelve a intentarlo.", 429);
    }
    if (!registrationEnabled()) {
      return c.html(registroPageHtml({ enabled: false }), 403);
    }

    const body = await c.req.parseBody();
    const email = String(body["email"] ?? "").trim().toLowerCase();
    const password = String(body["password"] ?? "");
    const confirm = String(body["confirm"] ?? "");
    const code = String(body["code"] ?? "");

    const fail = (error: string, status: 400 | 403 = 400) =>
      c.html(registroPageHtml({ enabled: true, error, email }), status);

    if (!safeEquals(code, config.registrationCode)) {
      return fail("Código de invitación incorrecto.", 403);
    }
    if (!EMAIL_RE.test(email)) return fail("Correo inválido.");
    if (password.length < 10) return fail("La contraseña debe tener al menos 10 caracteres.");
    if (password !== confirm) return fail("Las contraseñas no coinciden.");

    // 1) Crear el usuario (server-side; funciona aunque ALLOW_SIGNUP=false).
    try {
      await auth.api.signUpEmail({
        body: { email, password, name: email.split("@")[0] ?? email },
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
      tenants.setMapping(email, result.upstreamUrl);
      console.log(
        `[registro] tenant listo: ${email} -> ${result.upstreamUrl} (slug=${result.slug})`,
      );
      return c.html(registroExitoHtml(config.baseUrl, email));
    } catch (err) {
      console.error(`[registro] fallo aprovisionando tenant para ${email}:`, err);
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
    if (!registrationEnabled()) {
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

  // --- Post-callback de Google: HACE CUMPLIR el gate de invitación ---
  // El callback de Better Auth (/api/auth/callback/google) redirige aquí. En
  // este punto el usuario YA está autenticado (sesión creada). Reglas:
  //   - Usuario con tenant mapeado  -> login normal (reanuda OAuth si aplica).
  //   - Usuario sin tenant + cookie `registro_ok` válida -> aprovisiona y mapea
  //     (mismo flujo serializado que /registro).
  //   - Usuario sin tenant sin cookie válida -> NO aprovisiona, cierra sesión y
  //     muestra la página que pide un código de invitación.
  // Invariante: jamás se crea un mapeo de tenant sin un código de invitación
  // válido; un usuario sin mapeo sigue recibiendo 403 en /mcp.
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
      return c.html(
        '<!doctype html><meta charset="utf-8"><p style="font-family:system-ui">' +
          "Sesión iniciada. Ya puedes cerrar esta pestaña.</p>",
      );
    };

    const upstream = tenants.resolveUpstream(userId, email);
    if (upstream) return done(); // usuario existente: login normal

    // Usuario sin tenant: solo se aprovisiona con cookie de invitación válida.
    const cookie = getCookie(c, REGISTRO_COOKIE_NAME);
    if (verifyRegistroOk(cookie, config.registrationCode, config.authSecret)) {
      try {
        const result = await provisioner.provision(email);
        tenants.setMapping(email, result.upstreamUrl);
        deleteCookie(c, REGISTRO_COOKIE_NAME, { path: "/" });
        console.log(
          `[google] tenant listo: ${email} -> ${result.upstreamUrl} (slug=${result.slug})`,
        );
        return done();
      } catch (err) {
        console.error(`[google] fallo aprovisionando tenant para ${email}:`, err);
        return c.html(registroErrorProvisionHtml(email), 500);
      }
    }

    // Sin cookie válida: NO aprovisionar. Cierra la sesión y explica.
    console.warn(`[google] sesión sin tenant ni invitación válida: ${email} — cerrando sesión`);
    const signOut = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
    const response = new Response(googleSinInvitacionHtml(), {
      status: 403,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
    for (const setCookieHeader of signOut.headers.getSetCookie()) {
      response.headers.append("set-cookie", setCookieHeader);
    }
    return response;
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
