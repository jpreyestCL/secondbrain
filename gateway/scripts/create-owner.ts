/**
 * Crea el único usuario (dueño) del gateway.
 *
 * Uso: npm run create-owner -- correo@ejemplo.com "contraseña-segura"
 *
 * Se niega a crear un segundo usuario: este gateway es de un solo dueño.
 */
import { loadConfig, requireSecret } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { createTenantRegistry } from "../src/tenants.js";

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Uso: npm run create-owner -- correo@ejemplo.com "contraseña"');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error("La contraseña debe tener al menos 10 caracteres.");
    process.exit(1);
  }

  const config = loadConfig();
  requireSecret(config);

  // forceAllowSignup: el registro público está deshabilitado, pero este CLI
  // necesita poder crear al dueño.
  const { auth, db } = createAuth(config, { forceAllowSignup: true });
  await migrate(auth);

  const row = db.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number };
  if (row.n > 0) {
    console.error(
      `Ya existe ${row.n} usuario(s) en ${config.dbPath}. ` +
        "Este gateway es de un solo dueño; no se creará otro usuario.",
    );
    process.exit(1);
  }

  const result = await auth.api.signUpEmail({
    body: { email, password, name: "Owner" },
  });

  // La cuenta la crea el administrador desde la consola del servidor, con
  // acceso probado a esa dirección: se marca verificada sin pasar por el correo.
  // Si no, "Continuar con Google" fallaría con `account_not_linked` (Better Auth
  // exige el correo local verificado para enlazar) y habría que parchear la
  // base a mano, que es justo lo que se quiere evitar.
  db.prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?').run(result.user.id);

  console.log(`Dueño creado: ${result.user.email} (id: ${result.user.id}, correo verificado)`);
  console.log(`Base de datos: ${config.dbPath}`);

  // Mapea al dueño a su upstream Graphiti (GRAPHITI_MCP_URL) en tenants.json.
  const tenants = createTenantRegistry(config.tenantsFile);
  tenants.setMapping(result.user.email, config.graphitiMcpUrl);
  console.log(`Tenant asignado: ${result.user.email} -> ${config.graphitiMcpUrl}`);
  console.log(`Registro de tenants: ${config.tenantsFile}`);
  db.close();
}

main().catch((err) => {
  console.error("Error creando el dueño:", err?.message ?? err);
  process.exit(1);
});
