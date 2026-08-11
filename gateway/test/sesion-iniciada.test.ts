import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerType } from "@hono/node-server";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { listen, closeServer } from "./helpers.js";

let server: ServerType;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    tenantsFile: path.join(os.tmpdir(), `gw-sesion-${process.pid}.json`),
  });
  const { auth, db } = createAuth(config);
  await migrate(auth);
  const app = buildApp(auth, config, db, createTenantRegistry(config.tenantsFile));
  ({ server, baseUrl } = await listen(app));
});

afterAll(async () => {
  await closeServer(server);
});

describe("tras iniciar sesión se entra directo al panel", () => {
  it("/sesion-iniciada redirige a /cuenta (sin pantalla intermedia)", async () => {
    // Regresión: antes se mostraba una pantalla de "ya puedes cerrar esta
    // pestaña", que era un paso de más cuando no hay flujo OAuth que reanudar.
    const res = await fetch(`${baseUrl}/sesion-iniciada`, { redirect: "manual" });
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location")).toBe("/cuenta");
  });

  it("el login por correo lleva al panel, no a una pantalla suelta", async () => {
    const res = await fetch(`${baseUrl}/login`);
    const html = await res.text();
    expect(html).toContain("window.location.href = '/cuenta'");
    expect(html).not.toContain("Ya puedes cerrar esta pestaña");
  });

  it("/post-google sin sesión sigue mandando al login", async () => {
    const res = await fetch(`${baseUrl}/post-google`, { redirect: "manual" });
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location")).toContain("/login");
  });
});
