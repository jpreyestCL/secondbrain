/**
 * Agrega un usuario adicional (invitación manual, multi-tenant).
 *
 * Uso: npm run add-user -- correo@ejemplo.com "contraseña-segura"
 *
 * El usuario se crea SIN tenant asignado: no podrá usar /mcp (403) hasta que
 * el administrador agregue su upstream en tenants.json, por ejemplo:
 *   { "correo@ejemplo.com": "http://127.0.0.1:8022/mcp" }
 * Cada tenant debe apuntar a su PROPIA instancia de Graphiti (contenedor y
 * grafo separados) para mantener el aislamiento duro de datos.
 */
import { loadConfig, requireSecret } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Uso: npm run add-user -- correo@ejemplo.com "contraseña"');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error("La contraseña debe tener al menos 10 caracteres.");
    process.exit(1);
  }

  const config = loadConfig();
  requireSecret(config);

  const { auth, db } = createAuth(config, { forceAllowSignup: true });
  await migrate(auth);

  const result = await auth.api.signUpEmail({
    body: { email, password, name: email.split("@")[0] ?? email },
  });

  // Alta manual desde la consola del servidor: el administrador ya sabe de
  // quién es la dirección, así que la cuenta nace verificada. Sin esto, esa
  // persona no podría enlazar su Google (Better Auth lo rechaza mientras el
  // correo local esté sin verificar) hasta pasar por el correo.
  db.prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?').run(result.user.id);

  console.log(`Usuario creado: ${result.user.email} (id: ${result.user.id}, correo verificado)`);
  console.log("");
  console.log("IMPORTANTE: este usuario aún NO tiene tenant asignado y recibirá");
  console.log("403 en /mcp. Para habilitarlo, levanta SU propia instancia de");
  console.log(`Graphiti y agrega el mapeo en ${config.tenantsFile}:`);
  console.log(`  "${result.user.email}": "http://127.0.0.1:PUERTO/mcp"`);
  db.close();
}

main().catch((err) => {
  console.error("Error creando el usuario:", err?.message ?? err);
  process.exit(1);
});
