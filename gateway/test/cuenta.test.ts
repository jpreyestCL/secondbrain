/**
 * Panel de cuenta (/cuenta): qué ve el usuario y qué puede cortar por sí mismo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerType } from "@hono/node-server";
import type Database from "better-sqlite3";
import fs from "node:fs";
import { cuentaPageHtml } from "../src/cuenta-page.js";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { listen, closeServer, obtainAccessToken, hiddenFields } from "./helpers.js";

const PASSWORD = "supersecret-123";
const EMAIL = "cuenta@test.dev";
const UPSTREAM = "http://127.0.0.1:9099/mcp";

let server: ServerType;
let baseUrl: string;
let tenantsFile: string;
let db: Database.Database;

async function signIn(): Promise<string> {
  const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  return login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function cuenta(cookie: string): Promise<string> {
  const res = await fetch(`${baseUrl}/cuenta`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.text();
}

function post(
  cookie: string,
  url: string,
  fields: Record<string, string>,
  origin = baseUrl,
): Promise<Response> {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

const countSessions = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n;

beforeAll(async () => {
  tenantsFile = path.join(os.tmpdir(), `gw-cuenta-${process.pid}.json`);
  fs.writeFileSync(tenantsFile, JSON.stringify({ [EMAIL]: UPSTREAM }));
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    tenantsFile,
  });
  const created = createAuth(config);
  db = created.db;
  await migrate(created.auth);
  await created.auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: "c" } });
  const gw = await listen(
    buildApp(created.auth, config, created.db, createTenantRegistry(tenantsFile)),
  );
  server = gw.server;
  baseUrl = gw.baseUrl;
});

afterAll(async () => {
  await closeServer(server);
  fs.rmSync(tenantsFile, { force: true });
});

describe("panel de cuenta", () => {
  it("sin sesión redirige a /login", async () => {
    const res = await fetch(`${baseUrl}/cuenta`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("muestra correo, upstream, sesiones y clientes autorizados", async () => {
    const cookie = await signIn();
    // Un cliente OAuth autorizado de verdad (DCR -> consentimiento -> token).
    await obtainAccessToken(baseUrl, EMAIL, PASSWORD);

    const html = await cuenta(cookie);
    expect(html).toContain(EMAIL);
    // El upstream INTERNO no debe aparecer: no le sirve al usuario y expone
    // la topologia del servidor. Lo que se muestra es el conector publico.
    expect(html).not.toContain(UPSTREAM);
    expect(html).toContain("Tu espacio");
    expect(html).toContain("Sesiones activas");
    expect(html).toContain("test-client"); // nombre del cliente registrado
    expect(html).toContain("Revocar");
    expect(html).toContain("/export");
  });

  it("revocar un cliente borra su consentimiento y sus tokens de la base", async () => {
    const cookie = await signIn();
    await obtainAccessToken(baseUrl, EMAIL, PASSWORD);
    const clientId = (
      db
        .prepare('SELECT clientId FROM "oauthConsent" ORDER BY rowid DESC LIMIT 1')
        .get() as { clientId: string }
    ).clientId;
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM "oauthAccessToken" WHERE clientId = ?')
          .get(clientId) as { n: number }
      ).n,
    ).toBeGreaterThan(0);

    const csrf = hiddenFields(await cuenta(cookie))["csrf"]!;
    const res = await post(cookie, "/cuenta/revocar-cliente", { csrf, client_id: clientId });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/cuenta?ok=cliente-revocado");

    for (const table of ["oauthConsent", "oauthAccessToken", "oauthApplication"]) {
      const n = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE clientId = ?`)
          .get(clientId) as { n: number }
      ).n;
      expect(n).toBe(0);
    }
    expect(await cuenta(cookie)).not.toContain(clientId);
  });

  it("cerrar las demás sesiones deja solo la actual", async () => {
    const cookie = await signIn();
    await signIn();
    await signIn();
    expect(countSessions()).toBeGreaterThan(1);

    const csrf = hiddenFields(await cuenta(cookie))["csrf"]!;
    const res = await post(cookie, "/cuenta/cerrar-sesiones", { csrf });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/cuenta?ok=sesiones-cerradas");
    expect(countSessions()).toBe(1);
    // La sesión actual sigue viva.
    expect(await cuenta(cookie)).toContain("esta sesión");
  });

  it("en móvil no esconde los datos que la propia página pide revisar", async () => {
    // La página dice "si ves uno que no reconoces, ciérralos todos": para eso
    // hacen falta la hora de inicio y el User-Agent crudo, en cualquier pantalla.
    const cookie = await signIn();
    const html = await cuenta(cookie);
    expect(html).not.toMatch(/\.sesiones (th|td):nth-child\(2\)[^}]*display: none/);
    expect(html).not.toMatch(/\.sesiones td\.ua small \{ display: none/);
    // La tabla sigue siendo alcanzable: se desplaza en horizontal.
    expect(html).toContain('<div class="scroll">');
    expect(html).toContain(".scroll table { min-width:");
    // Y el User-Agent completo viaja en el HTML, no solo la etiqueta resumida.
    expect(html).toContain("<small>");
  });

  it("los POST rechazan peticiones cross-origin y tokens CSRF inválidos", async () => {
    const cookie = await signIn();
    const csrf = hiddenFields(await cuenta(cookie))["csrf"]!;

    const crossOrigin = await post(
      cookie,
      "/cuenta/cerrar-sesiones",
      { csrf },
      "https://evil.example.com",
    );
    expect(crossOrigin.status).toBe(403);

    const badToken = await post(cookie, "/cuenta/cerrar-sesiones", { csrf: "0".repeat(64) });
    expect(badToken.status).toBe(403);

    const noOrigin = await fetch(`${baseUrl}/cuenta/cerrar-sesiones`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
    });
    expect(noOrigin.status).toBe(403);
  });
});

describe("identidad del espacio", () => {
  it("muestra el slug del tenant, que es lo que el CLI necesita", async () => {
    const cookie = await signIn();
    const html = await cuenta(cookie);
    // El panel decia solo el upstream interno (http://127.0.0.1:8021/mcp), que
    // no le sirve a nadie: la guia pide `brain --tenant <slug>` y el usuario no
    // tenia donde leer su slug.
    expect(html).toContain("Tu espacio");
    expect(html).toContain("brain --tenant");
  });
});

describe("instalador del CLI", () => {
  it("se sirve como shell script y no pide claves de API", async () => {
    const res = await fetch(`${baseUrl}/install.sh`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("shellscript");
    const script = await res.text();
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    // El punto del instalador: la extraccion la hace el servidor, asi que el
    // cliente no configura ninguna clave de LLM.
    expect(script).not.toMatch(/OPENAI_API_KEY|LLM_API_KEY=/);
    expect(script).toContain("brain login");
    // --frozen es lo que impide que uv resuelva versiones no probadas.
    expect(script).toContain("--frozen");
  });
});

describe("resumen de la memoria", () => {
  const resumen = {
    documentos: 17,
    fragmentos: 47,
    personasYEmpresas: 124,
    datosActuales: 137,
    datosQueCambiaron: 3,
    porDominio: { finanzas: 12, personal: 5 },
    ultimos: [
      { documento: "[finanzas] Escritura compraventa.pdf", dominio: "finanzas", guardado: "2026-08-13T01:00:00Z" },
    ],
  };

  it("habla en palabras que el usuario entiende, no en jerga del grafo", async () => {
    const html = cuentaPageHtml({
      email: "a@b.cl", emailVerified: true, upstream: "http://x/mcp", mcpUrl: "https://y/mcp",
      tenant: "ana", sessions: [], clients: [], csrf: "t", resumen,
    });
    expect(html).toContain("documentos guardados");
    expect(html).toContain("datos que sé de ti");
    expect(html).toContain("personas, empresas y lugares");
    // Nadie sabe qué es un episodio, una entidad o un hecho vigente.
    expect(html).not.toContain("episodio");
    expect(html).not.toContain("entidades");
    expect(html).not.toContain("hechos vigentes");
    expect(html).toContain("17");
    expect(html).toContain("Escritura compraventa.pdf");
  });

  it("con la memoria vacía invita a guardar en vez de mostrar ceros", async () => {
    const html = cuentaPageHtml({
      email: "a@b.cl", emailVerified: true, upstream: "http://x/mcp", mcpUrl: "https://y/mcp",
      tenant: "ana", sessions: [], clients: [], csrf: "t",
      resumen: { ...resumen, documentos: 0, datosActuales: 0, personasYEmpresas: 0, ultimos: [] },
    });
    expect(html).toContain("Todavía no has guardado nada");
    expect(html).toContain("brain add");
  });

  it("omite la sección si el servidor no sabe responder el resumen", async () => {
    // Un servidor viejo sin get_stats: mostrar ceros se leería como "no tienes
    // nada guardado", que es el mensaje equivocado.
    const html = cuentaPageHtml({
      email: "a@b.cl", emailVerified: true, upstream: "http://x/mcp", mcpUrl: "https://y/mcp",
      tenant: "ana", sessions: [], clients: [], csrf: "t", resumen: null,
    });
    expect(html).not.toContain("Tu memoria");
    expect(html).toContain("Tu cuenta");
  });

  it("marca los datos que ya no están vigentes", async () => {
    const html = cuentaPageHtml({
      email: "a@b.cl", emailVerified: true, upstream: "http://x/mcp", mcpUrl: "https://y/mcp",
      tenant: "ana", sessions: [], clients: [], csrf: "t", resumen,
      busqueda: {
        consulta: "cuenta bancaria",
        datos: [
          { texto: "Cuenta Banco de Chile 123", desde: "2024-03-10", hasta: "2026-08-01" },
          { texto: "Cuenta Santander 456", desde: "2026-08-01", hasta: null },
        ],
      },
    });
    expect(html).toContain("ya no vigente desde");
    expect(html).toContain("Cuenta Santander 456");
  });
});

describe("constelación de una entidad", () => {
  const cons = {
    entidad: "Invest Andes LP",
    uuid: "u-centro",
    relaciones: [
      { con: "Inversiones Linets SpA", uuid: "u-1", dato: "Inversiones Linets SpA posee el 99,9% de Invest Andes LP", desde: "2022-10-31", hasta: "" },
      { con: "Banco de Chile", uuid: "u-2", dato: "Invest Andes LP tuvo cuenta en Banco de Chile", desde: "2023-01-01", hasta: "2026-08-01" },
    ],
  };
  const base = {
    email: "a@b.cl", emailVerified: true, upstream: "http://x/mcp", mcpUrl: "https://y/mcp",
    tenant: "ana", sessions: [], clients: [], csrf: "t", resumen: null,
  };

  it("dibuja lo vigente y lo caducado distinto", () => {
    const html = cuentaPageHtml({ ...base, constelacion: cons });
    expect(html).toContain('class="constelacion"');
    // La vigencia se codifica en la FORMA, no solo en el texto: lo que dejó de
    // ser verdad va discontinuo y en el color de lo histórico.
    expect(html).toContain('class="arista viva"');
    expect(html).toContain('class="arista historica"');
    expect(html).toContain("Invest Andes LP");
    expect(html).toContain("Banco de Chile");
  });

  it("cada vecino es navegable, para seguir el hilo", () => {
    const html = cuentaPageHtml({ ...base, constelacion: cons });
    expect(html).toContain("/cuenta?entidad=u-1");
    expect(html).toContain("/cuenta?entidad=u-2");
  });

  it("una entidad aislada lo dice, en vez de mostrar un lienzo vacío", () => {
    const html = cuentaPageHtml({
      ...base,
      constelacion: { entidad: "Algo suelto", uuid: "u-0", relaciones: [] },
    });
    expect(html).toContain("Todavía no hay nada conectado");
    // El shell trae sus propios iconos SVG: se comprueba el del dibujo.
    expect(html).not.toContain('class="constelacion"');
  });

  it("escapa los nombres: un dato guardado no puede inyectar markup", () => {
    const html = cuentaPageHtml({
      ...base,
      constelacion: {
        entidad: '<script>alert(1)</script>',
        uuid: "u-x",
        relaciones: [{ con: "<img onerror=x>", uuid: "u-y", dato: "d", desde: "", hasta: "" }],
      },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img onerror=x>");
  });
});

describe("panel de cuenta bilingüe", () => {
  const resumen = {
    documentos: 17,
    fragmentos: 47,
    personasYEmpresas: 124,
    datosActuales: 137,
    datosQueCambiaron: 3,
    porDominio: { finanzas: 12 },
    ultimos: [
      { documento: "Escritura.pdf", dominio: "finanzas", guardado: "2026-08-13T01:00:00Z" },
    ],
  };
  const base = {
    email: "a@b.cl",
    emailVerified: false,
    upstream: "http://x/mcp",
    mcpUrl: "https://y/mcp",
    tenant: "ana",
    sessions: [],
    clients: [],
    csrf: "t",
    resumen,
  };
  const en = cuentaPageHtml({ ...base, idioma: "en", url: "/cuenta" });

  it("sin idioma la página entera sigue en español", () => {
    const es = cuentaPageHtml(base);
    expect(es).toContain("Tu cuenta");
    expect(es).toContain("Tu espacio");
    expect(es).toContain("Qué tienes guardado");
    expect(es).toContain("Buscar en tu memoria");
    expect(es).toContain("Sesiones activas");
    expect(es).toContain("Aplicaciones autorizadas");
    expect(es).toContain("Descargar mi memoria (JSON)");
  });

  it("en inglés traduce cabecera, resumen, buscador, export y accesos", () => {
    expect(en).toContain("Your account");
    expect(en).toContain("Your space");
    expect(en).toContain("What you’ve saved");
    expect(en).toContain("documents saved");
    expect(en).toContain("Search your memory");
    expect(en).toContain("Active sessions");
    expect(en).toContain("Authorized applications");
    expect(en).toContain("Download my memory (JSON)");
    // Y nada del español se cuela.
    expect(en).not.toContain("Tu cuenta");
    expect(en).not.toContain("Tu espacio");
    expect(en).not.toContain("Sesiones activas");
    expect(en).not.toContain("Descargar mi memoria");
  });

  it("en inglés habla de documentos, no de episodios ni entidades", () => {
    expect(en).toContain("documents saved");
    expect(en).toContain("things I know about you");
    expect(en).toContain("people, companies and places");
    expect(en.toLowerCase()).not.toContain("episode");
    expect(en.toLowerCase()).not.toContain("entities");
    expect(en.toLowerCase()).not.toContain("current facts");
  });

  it("traduce el aviso de correo sin verificar y su botón", () => {
    expect(en).toContain("Your email is not verified yet");
    expect(en).toContain("Resend verification");
    expect(en).not.toContain("Reenviar verificación");
  });

  it("traduce el buscador: marcador, botón, espera y «sin resultados»", () => {
    const vacio = cuentaPageHtml({
      ...base,
      idioma: "en",
      busqueda: { consulta: "bank", datos: [] },
    });
    expect(vacio).toContain('placeholder="what is my bank account?"');
    expect(vacio).toContain(">Search</button>");
    expect(vacio).toContain("Searching your memory…");
    expect(vacio).toContain('btn.textContent = "Copy"');
    expect(vacio).toContain("I found nothing for &ldquo;bank&rdquo;");
    expect(vacio).not.toContain("No encontré nada");
  });

  it("traduce la vigencia de los datos encontrados", () => {
    const html = cuentaPageHtml({
      ...base,
      idioma: "en",
      busqueda: {
        consulta: "cuenta",
        datos: [
          { texto: "Account 123", desde: "2024-03-10", hasta: "2026-08-01" },
          { texto: "Account 456", desde: "2026-08-01", hasta: null },
        ],
        entidades: [{ nombre: "Banco", uuid: "u-1", resumen: "" }],
      },
    });
    expect(html).toContain("— no longer current since");
    expect(html).toContain("— since");
    expect(html).toContain("People, companies and places");
    expect(html).not.toContain("ya no vigente desde");
  });

  it("traduce la constelación: relaciones, vigencia del SVG y texto alternativo", () => {
    const cons = {
      entidad: "Invest Andes LP",
      uuid: "u-centro",
      relaciones: [
        { con: "Linets SpA", uuid: "u-1", dato: "posee", desde: "2022-10-31", hasta: "" },
        { con: "Banco", uuid: "u-2", dato: "tuvo cuenta", desde: "2023-01-01", hasta: "2026-08-01" },
      ],
    };
    const html = cuentaPageHtml({ ...base, idioma: "en", constelacion: cons });
    expect(html).toContain("Connections of Invest Andes LP");
    expect(html).toContain("1 current connection");
    expect(html).toContain("that already changed");
    expect(html).toContain("Click any name to follow the thread");
    expect(html).toContain("since Oct 2022");
    expect(html).toContain("until Aug 2026");
    expect(html).toContain("← back to the summary");
    expect(html).not.toContain("Relaciones de");
    expect(html).not.toContain("ago 2026");

    // Y en español todo sigue igual que siempre.
    const es = cuentaPageHtml({ ...base, constelacion: cons });
    expect(es).toContain("Relaciones de Invest Andes LP");
    expect(es).toContain("1 relación vigente");
    expect(es).toContain("desde oct 2022");
    expect(es).toContain("hasta ago 2026");
  });

  it("una entidad aislada lo dice también en inglés", () => {
    const html = cuentaPageHtml({
      ...base,
      idioma: "en",
      constelacion: { entidad: "Algo", uuid: "u-0", relaciones: [] },
    });
    expect(html).toContain("Nothing is connected to this yet.");
    expect(html).not.toContain("Todavía no hay nada conectado");
  });

  it("con la memoria vacía invita a guardar en inglés, con la carpeta traducida", () => {
    const html = cuentaPageHtml({
      ...base,
      idioma: "en",
      resumen: { ...resumen, documentos: 0, ultimos: [] },
    });
    expect(html).toContain("You haven’t saved anything yet");
    expect(html).toContain("brain add &lt;folder&gt;");
    // El diccionario guarda `<folder>` en crudo: quien escapa es la plantilla.
    expect(html).not.toContain("&amp;lt;");
  });

  it("traduce las sesiones y el nombre del dispositivo", () => {
    const html = cuentaPageHtml({
      ...base,
      idioma: "en",
      sessions: [
        {
          id: "s1",
          createdAt: "2026-08-01T00:00:00Z",
          lastUsed: "2026-08-02T00:00:00Z",
          ipAddress: "1.2.3.4",
          userAgent: null,
          current: true,
        },
        {
          id: "s2",
          createdAt: "2026-08-01T00:00:00Z",
          lastUsed: "2026-08-02T00:00:00Z",
          ipAddress: null,
          userAgent: "curl/8.4",
          current: false,
        },
      ],
    });
    expect(html).toContain(">Last used</th>");
    expect(html).toContain(">Browser</th>");
    expect(html).toContain("this session");
    expect(html).toContain("Unknown");
    expect(html).toContain("Command-line client");
    expect(html).toContain("Sign out of all other sessions (1)");
    expect(html).not.toContain("esta sesión");
  });

  it("traduce las aplicaciones autorizadas y el caso sin ninguna", () => {
    expect(en).toContain("You haven’t authorized any application yet.");
    const conApp = cuentaPageHtml({
      ...base,
      idioma: "en",
      clients: [
        {
          clientId: "c1",
          name: "Claude",
          redirectOrigins: ["https://claude.ai"],
          authorizedAt: "2026-08-01T00:00:00Z",
          activeTokens: 2,
        },
      ],
    });
    expect(conApp).toContain("Redirects back to");
    expect(conApp).toContain("Authorized on");
    expect(conApp).toContain("active token(s)");
    expect(conApp).toContain(">Revoke</button>");
    expect(conApp).not.toContain(">Revocar</button>");
  });
});
