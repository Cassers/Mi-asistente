# Contrato de distribución

## Requisitos

1. Un clon nuevo permite instalar y levantar OpenCode, bridge e interfaz con pnpm.
2. El clon no contiene identidad, credenciales, chats, grabaciones ni backups ajenos.
3. El primer chat elige nombre/estilo y los siguientes pueden retomarse.
4. Repetir setup conserva los datos; al cerrar solo se detienen procesos propios.
5. Captura e historial se activan por elección; no se prometen conectores ausentes.

## Diseño

Código y plantillas versionados; datos runtime en opencode/ y recordings/,
ignorados por Git. Setup copia solo archivos inexistentes y genera ruta MCP
absoluta para cada clon. OpenCode usa configuración/datos/estado/caché aislados.
Arranque con puertos estrictos, contraseña efímera y procesos hijos propios.
Sin actualización de dependencias ni cambio del modelo seleccionado al empaquetar.

## Entrega y verificación

- Copia de fuentes/assets por allowlist; licencia y atribución conservadas.
- Plantillas genéricas, inicializador, launcher y pruebas de aislamiento.
- Regresión, build, instalación frozen-lockfile y arranque aislado sin capturas.
- Auditoría de archivos a publicar antes del primer push público.

La unidad de entrega es el nuevo repo: rollback local consiste en dejar de
ejecutar este clon. No se modifica la app original ni sus datos o remoto.
Los cambios de voz solicitados durante el empaquetado tienen respaldo separado
en la instalación original. Nunca se distribuye ese respaldo privado.

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
