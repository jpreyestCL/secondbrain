import { describe, it, expect } from "vitest";
import { csrfToken, verifyCsrfToken } from "../src/csrf.js";

describe("token CSRF ligado al usuario", () => {
  it("sobrevive a un cambio de sesión (regresión del 'Token CSRF inválido')", () => {
    // Antes el token se ligaba a la sesión: volver a entrar (p.ej. con Google en
    // otra pestaña) invalidaba el formulario de cualquier página ya abierta.
    const secret = "s".repeat(40);
    const userId = "usuario-1";
    const emitidoConSesionVieja = csrfToken(userId, secret);
    // ...la sesión cambia, el usuario es el mismo...
    expect(verifyCsrfToken(emitidoConSesionVieja, userId, secret)).toBe(true);
  });

  it("no vale el token de otro usuario", () => {
    const secret = "s".repeat(40);
    expect(verifyCsrfToken(csrfToken("usuario-1", secret), "usuario-2", secret)).toBe(false);
  });

  it("no vale con otro secreto", () => {
    expect(verifyCsrfToken(csrfToken("u", "a".repeat(40)), "u", "b".repeat(40))).toBe(false);
  });

  it("rechaza vacío o no-string", () => {
    const secret = "s".repeat(40);
    expect(verifyCsrfToken("", "u", secret)).toBe(false);
    expect(verifyCsrfToken(undefined, "u", secret)).toBe(false);
  });
});
