import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  withMcpAuth,
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from "better-auth/plugins";
import type Database from "better-sqlite3";
import type { GatewayConfig } from "./env.js";
import type { Auth } from "./auth.js";
import { proxyMcp } from "./proxy.js";
import { loginPageHtml } from "./login-page.js";
import type { TenantRegistry } from "./tenants.js";

export function buildApp(
  auth: Auth,
  config: GatewayConfig,
  db: Database.Database,
  tenants: TenantRegistry,
): Hono {
  const app = new Hono();

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

  // --- Better Auth: login, OAuth authorize/token/register (DCR), sessions ---
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // --- Login page (single owner, Spanish) ---
  app.get("/login", (c) => c.html(loginPageHtml()));
  app.get("/", (c) => c.redirect("/login"));
  app.get("/health", (c) => c.json({ ok: true }));

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
