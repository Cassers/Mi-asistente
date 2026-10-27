# Contrato de distribución

## Requisitos

1. Un clon nuevo instala con pnpm y arranca el cliente nativo Codex/OpenCode,
   bridge e interfaz con pnpm start.
2. El clon no contiene identidad, credenciales, chats, grabaciones ni backups ajenos.
3. La carpeta elegida conserva sus instrucciones, modelos y conversaciones nativas.
4. Setup y el instalador opcional conservan el workspace aislado de compatibilidad.
5. Captura e historial se activan por elección; no se prometen modalidades ausentes.
6. Al cerrar solo se detienen procesos propios; un servidor externo sigue activo.

## Diseño

Código y plantillas versionados. El lanzador nativo es Node, conserva las ubicaciones
de cuenta/configuración global y abre el proyecto real mediante su cliente nativo.
El plugin de audio de OpenCode se agrega solo al servidor propio en ejecución.
La cuenta, los permisos, los modelos y el historial de Codex se resuelven por su CLI.
No hay actualización de dependencias ni fallback de pago al empaquetar.

El lanzador anterior y sus datos permanecen como modo legacy. Setup crea solo
archivos inexistentes en opencode/, incluyendo la ruta MCP absoluta para ese clon;
no aplica esas carpetas XDG aisladas al cliente nativo. El orquestador opcional se
instala únicamente allí. Las plantillas genéricas siguen anónimas.

## Entrega y verificación

- Copia por allowlist con hashes en [publication-manifest.json](publication-manifest.json).
- Evidencia y limitaciones en [publication-preparation.md](publication-preparation.md).
- Suite completa con concurrencia 2, build, lint y prueba nativa Codex opt-in contra
  Responses local, sin modelo remoto ni cuentas personales.
- Smoke real del lanzador en Linux con HOME/XDG/estado temporales y tres puertos
  altos; salud OpenCode/bridge, página y cierre de todos los grupos propios.
- Auditoría de todos los candidatos mediante índice temporal, conservando intacto
  el índice real que revisará el responsable de publicación antes de commit/push.

La unidad de entrega son cambios sin commit en este repo; el alcance exacto está
en el manifiesto. Revertir únicamente esa unidad a la revisión base restaura el
paquete anterior sin modificar el origen ni eliminar runtime o datos privados.

## Recibo inicial (2026-10-23)

- Instalación limpia `pnpm install --frozen-lockfile --offline`: 255 paquetes del
  lockfile, sin descargas ni actualización de versiones; scripts permitidos de
  esbuild y OpenCode. Node 24.15.0 y pnpm 11.15.1 en Linux x64.
- Regresión: 93/93 pruebas, sin llamadas de inferencia ni periféricos reales.
- `pnpm build`: TypeScript y Vite correctos; advertencias heredadas de SDK
  node:* externo y chunks grandes. Lint enfocado: sin diagnósticos.
- Arranque real aislado: puertos 5191/8799/4107, frontend HTTP200, OpenCode
  estándar disponible, bridge Manual, perfil vacío, captura/historial apagados.
  Catálogo de 9 modelos sin credenciales personales. No confirma inferencia
  remota ni soporte acústico del navegador de cada estudiante.
- HTML/CSP comprobado con el puerto alternativo del bridge. Cierre por el
  launcher propio y puertos liberados; ninguna instancia existente detenida.
- Índice Git: 132 archivos por allowlist, sin .env.local, runtime, perfil
  personal, chats, cookies, grabaciones, logs ni backups. Auditoría básica
  adicional de patrones de secretos y rutas locales: sin coincidencias.
