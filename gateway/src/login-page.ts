/**
 * Página de inicio de sesión mínima (en español) para el único dueño del
 * gateway. Tras autenticarse, vuelve a lanzar la petición de autorización
 * OAuth original (los parámetros llegan en la query string).
 */
export function loginPageHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Second Brain — Iniciar sesión</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f5f5f4; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #e7e5e4; } }
  form { background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; padding: 2rem; width: min(90vw, 22rem); display: grid; gap: .75rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 .5rem; font-size: .85rem; opacity: .7; }
  label { font-size: .85rem; font-weight: 600; }
  input { font: inherit; padding: .55rem .7rem; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: transparent; color: inherit; }
  button { font: inherit; font-weight: 600; padding: .6rem; border: 0; border-radius: 8px; background: #4f46e5; color: white; cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
  #error { color: #dc2626; font-size: .85rem; min-height: 1.2em; margin: 0; }
</style>
</head>
<body>
<form id="f">
  <h1>Second Brain Gateway</h1>
  <p class="sub">Inicia sesión para autorizar el acceso de Claude a tu memoria.</p>
  <label for="email">Correo</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Contraseña</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <p id="error"></p>
  <button type="submit">Entrar</button>
</form>
<script>
  const form = document.getElementById('f');
  const errEl = document.getElementById('error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errEl.textContent = data.message || 'Credenciales inválidas.';
        btn.disabled = false;
        return;
      }
      const params = window.location.search;
      if (params && params.length > 1) {
        // Reanuda el flujo OAuth original con los mismos parámetros.
        window.location.href = '/api/auth/mcp/authorize' + params;
      } else {
        document.body.innerHTML = '<p style="font-family:system-ui">Sesión iniciada. Ya puedes cerrar esta pestaña.</p>';
      }
    } catch (err) {
      errEl.textContent = 'Error de red. Inténtalo de nuevo.';
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
