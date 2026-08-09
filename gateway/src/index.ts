import { serve } from "@hono/node-server";
import { loadConfig, requireSecret } from "./env.js";
import { createAuth, migrate } from "./auth.js";
import { buildApp } from "./server.js";
import { createTenantRegistry } from "./tenants.js";

async function main(): Promise<void> {
  const config = loadConfig();
  requireSecret(config);

  const { auth, db } = createAuth(config);
  await migrate(auth);

  const tenants = createTenantRegistry(config.tenantsFile);
  const app = buildApp(auth, config, db, tenants);

  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`[gateway] escuchando en http://${config.host}:${info.port}`);
    console.log(`[gateway] BASE_URL publica: ${config.baseUrl}`);
    console.log(`[gateway] registro de tenants: ${config.tenantsFile}`);
    console.log(`[gateway] registro abierto (ALLOW_SIGNUP): ${config.allowSignup}`);
  });
}

main().catch((err) => {
  console.error("[gateway] error fatal:", err);
  process.exit(1);
});
