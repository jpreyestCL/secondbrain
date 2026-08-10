/**
 * Sesiones más cortas con rotación (SESSION_MAX_AGE_DAYS / SESSION_UPDATE_AGE_MINUTES).
 */
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/env.js";
import { createAuth } from "../src/auth.js";

function authWith(overrides: Parameters<typeof loadConfig>[0]) {
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    ...overrides,
  });
  return createAuth(config).auth;
}

describe("configuración de sesión", () => {
  it("por defecto la sesión dura 2 días (antes 7) y rota cada hora de uso", () => {
    const auth = authWith({});
    expect(auth.options.session?.expiresIn).toBe(2 * 24 * 60 * 60);
    expect(auth.options.session?.updateAge).toBe(60 * 60);
    // El default de Better Auth eran 7 días: la regresión se nota aquí.
    expect(auth.options.session?.expiresIn).toBeLessThan(7 * 24 * 60 * 60);
  });

  it("SESSION_MAX_AGE_DAYS y SESSION_UPDATE_AGE_MINUTES se aplican", () => {
    const auth = authWith({ sessionMaxAgeDays: 0.5, sessionUpdateAgeMinutes: 5 });
    expect(auth.options.session?.expiresIn).toBe(12 * 60 * 60);
    expect(auth.options.session?.updateAge).toBe(5 * 60);
  });

  it("valores basura en el entorno caen al default en vez de romper el login", () => {
    const previous = process.env.SESSION_MAX_AGE_DAYS;
    process.env.SESSION_MAX_AGE_DAYS = "no-es-un-numero";
    try {
      expect(loadConfig().sessionMaxAgeDays).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.SESSION_MAX_AGE_DAYS;
      else process.env.SESSION_MAX_AGE_DAYS = previous;
    }
  });

  it("updateAge=0 (refrescar en cada petición) es un valor válido", () => {
    const auth = authWith({ sessionUpdateAgeMinutes: 0 });
    expect(auth.options.session?.updateAge).toBe(0);
  });
});
