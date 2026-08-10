/**
 * Cliente de Resend (src/mailer.ts): payload exacto, modo debug, manejo de
 * errores y el registro de envíos del que depende la degradación elegante.
 *
 * NUNCA se toca la red: `globalThis.fetch` se sustituye por un doble.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createMailer,
  MailError,
  DEFAULT_MAIL_FROM,
  recordDelivery,
  lastDelivery,
  resetDeliveries,
} from "../src/mailer.js";

const MESSAGE = {
  to: "quien@ejemplo.cl",
  subject: "Confirma tu correo",
  html: "<p>hola</p>",
  text: "hola",
};

const realFetch = globalThis.fetch;

function stubFetch(response: Response): { calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push([String(url), init]);
    return response;
  }) as unknown as typeof fetch;
  return { calls };
}

beforeEach(() => {
  resetDeliveries();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("createMailer", () => {
  it("manda a Resend el payload esperado y devuelve el id", async () => {
    const spy = stubFetch(
      new Response(JSON.stringify({ id: "re_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const mailer = createMailer({
      resendApiKey: "re_test_key",
      mailFrom: "Second Brain <hola@rlz.cl>",
      mailDebug: false,
    });
    expect(mailer.enabled).toBe(true);

    const result = await mailer.send(MESSAGE);
    expect(result).toEqual({ id: "re_123", debug: false });

    expect(spy.calls).toHaveLength(1);
    const [url, init] = spy.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key");
    expect(headers["content-type"]).toBe("application/json");
    // Payload de la API de Resend: `to` SIEMPRE es un arreglo.
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Second Brain <hola@rlz.cl>",
      to: ["quien@ejemplo.cl"],
      subject: "Confirma tu correo",
      html: "<p>hola</p>",
      text: "hola",
    });
  });

  it("usa el remitente por defecto cuando MAIL_FROM viene vacío", async () => {
    const spy = stubFetch(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    const mailer = createMailer({ resendApiKey: "k", mailFrom: "  ", mailDebug: false });
    await mailer.send(MESSAGE);
    expect(JSON.parse(String(spy.calls[0]![1].body)).from).toBe(DEFAULT_MAIL_FROM);
  });

  it("MAIL_DEBUG=1 no toca la red: escribe el correo en el log", async () => {
    const spy = stubFetch(new Response("no debería usarse", { status: 500 }));
    const mailer = createMailer({
      resendApiKey: "re_test_key",
      mailFrom: DEFAULT_MAIL_FROM,
      mailDebug: true,
    });
    const result = await mailer.send(MESSAGE);
    expect(result).toEqual({ id: null, debug: true });
    expect(spy.calls).toHaveLength(0);
  });

  it("sin RESEND_API_KEY el correo queda deshabilitado y send lanza mail_disabled", async () => {
    const mailer = createMailer({
      resendApiKey: "",
      mailFrom: DEFAULT_MAIL_FROM,
      mailDebug: false,
    });
    expect(mailer.enabled).toBe(false);
    await expect(mailer.send(MESSAGE)).rejects.toBeInstanceOf(MailError);
    await expect(mailer.send(MESSAGE)).rejects.toMatchObject({ code: "mail_disabled" });
  });

  it("un 4xx de Resend se convierte en MailError con el mensaje de la API", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          statusCode: 403,
          name: "validation_error",
          message: "The rlz.cl domain is not verified.",
        }),
        { status: 403 },
      ),
    );
    const mailer = createMailer({
      resendApiKey: "k",
      mailFrom: "Second Brain <hola@rlz.cl>",
      mailDebug: false,
    });
    const err = await mailer.send(MESSAGE).catch((e) => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect(err.code).toBe("resend_error");
    expect(err.status).toBe(403);
    expect(err.message).toContain("The rlz.cl domain is not verified.");
  });

  it("un 5xx también lanza MailError con el estado", async () => {
    stubFetch(new Response("boom", { status: 502 }));
    const mailer = createMailer({ resendApiKey: "k", mailFrom: "", mailDebug: false });
    const err = await mailer.send(MESSAGE).catch((e) => e as MailError);
    expect(err.code).toBe("resend_error");
    expect(err.status).toBe(502);
  });

  it("un fallo de red se reporta como network_error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const mailer = createMailer({ resendApiKey: "k", mailFrom: "", mailDebug: false });
    const err = await mailer.send(MESSAGE).catch((e) => e as MailError);
    expect(err.code).toBe("network_error");
    expect(err.message).toContain("ECONNRESET");
  });
});

describe("registro de envíos", () => {
  it("guarda el último resultado por dirección, normalizando el correo", () => {
    expect(lastDelivery("nadie@ejemplo.cl")).toBeNull();
    recordDelivery("Alguien@Ejemplo.CL", { ok: false, error: "sin clave" });
    expect(lastDelivery("alguien@ejemplo.cl")).toMatchObject({
      ok: false,
      error: "sin clave",
    });
    recordDelivery("alguien@ejemplo.cl", { ok: true });
    expect(lastDelivery("ALGUIEN@ejemplo.cl")?.ok).toBe(true);
  });
});
