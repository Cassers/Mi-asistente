# Mi asistente

Cliente local de voz y texto para **Codex y OpenCode**. Abre una carpeta real y
continúa sus conversaciones nativas, con sus instrucciones, agentes, modelos,
skills y permisos. Cada aplicación conserva su cuenta y su historial.

## Empezar

Requisitos: **Node.js 22.12+**, **pnpm 11**, Git y Google Chrome. Para usar Codex,
instala su CLI y autentícate con tu propia cuenta antes de abrir un proyecto.
OpenCode 1.19.3 viene fijado en el lockfile.

```bash
git clone https://github.com/Cassers/Mi-asistente.git
cd Mi-asistente
pnpm install --frozen-lockfile
pnpm run setup
pnpm start
```

Abre **http://127.0.0.1:5173**, activa el audio, elige Codex u OpenCode y abre una
carpeta de confianza. Escribe su ruta absoluta si no tienes selector nativo
(zenity). Selecciona un chat existente o crea uno. El micrófono se activa desde
la interfaz; también puedes escribir. **Ctrl+C cierra los procesos de esta instancia**.

El arranque nativo usa tu cuenta y configuración global, junto con las de la
carpeta elegida. No copia credenciales ni impone el asistente de las plantillas.
El modelo, agente y pensamiento iniciales proceden del cliente nativo; una
selección explícita se conserva por proyecto. No hay fallback automático de pago.
Para conectar un proveedor de OpenCode, usa su CLI nativo en tu entorno habitual.
Para Codex, comprueba primero que su CLI funciona desde la carpeta elegida.

## Arranque nativo y compatibilidad

`pnpm start` usa un lanzador Node, sin bash: inicia OpenCode en el directorio
personal (o JARVIS_OC_DIRECTORY), espera su salud y levanta el bridge de proyectos
y Vite. Agrega el plugin de audio solo mediante configuración de ejecución; no
reescribe la configuración global o de tus proyectos. Conserva las ubicaciones
nativas XDG y CODEX_HOME. No reemplaza una instancia ajena si el puerto está ocupado.

Para conectar un servidor OpenCode local ya iniciado, configura OPENCODE_URL y,
si corresponde, OPENCODE_SERVER_PASSWORD en .env.local. El lanzador comprueba su
salud y no lo detiene al salir. Su propietario debe cargar
bridge/opencode-audio-plugin.mjs si necesita clips directos compatibles.

```bash
# Compatibilidad con el asistente aislado anterior:
pnpm start:legacy
pnpm opencode -- auth login
# Solo el bridge nativo o el bridge anterior:
pnpm bridge
pnpm bridge:legacy
```

Setup, el comando opencode y el instalador opcional siguen trabajando en el
workspace aislado de compatibilidad. No cambian la cuenta global usada por el
arranque nativo. La instalación opcional se documenta en
[Orquestador opcional](docs/optional-harness.md).

## Qué incluye

- Selector de aplicación, carpeta, conversaciones, modelos y pensamiento nativos.
- Conversación desplazable, compositor de texto, respuestas enriquecidas y permisos
  visibles. Desconectar la vista no elimina ni aborta un chat nativo.
- Voz del navegador con selector y velocidad, control de micrófono independiente
  de pausar la conversación y de detener la respuesta.
- Modos de entrada de voz: clips directos en rutas compatibles o Solo transcripción.
  Los clips necesitan capacidades y transporte nativos compatibles; un fallo
  directo se muestra sin sustituirlo silenciosamente por dictado.
- Captura actual e historial local opcionales. Las funciones de escritorio
  requieren Linux con niri/Wayland, grim, ffmpeg y pactl. Arranque con captura e
  historial apagados; encenderlos exige una elección explícita.
- Panel de tiempos locales sin contenido de mensajes, imágenes, audio o claves.

Consulta [proyectos nativos](docs/project-client.md),
[mediciones](docs/performance.md) y [flujo de voz](docs/voice-flow-review-2026-10-26.md).
Los modelos, permisos, herramientas y modalidades siguen limitados por cada cliente
nativo y su proveedor. El reconocimiento del navegador puede enviar voz a su
servicio. Codex no garantiza admitir los mismos clips que OpenCode.

## Configuración local y datos

Copia .env.example a .env.local solo si necesitas cambiar puertos o preferencias.
Nunca pongas claves en VITE_*: esas variables se incluyen en el navegador.

| Ubicación | Contenido |
| --- | --- |
| templates/ | Plantillas anónimas de compatibilidad, versionadas |
| opencode/ | Workspace, cuenta y runtime del modo aislado anterior, ignorados |
| Carpeta elegida y datos nativos del cliente | Instrucciones y conversaciones del proyecto |
| ~/.local/state/mi-asistente/ | Registro local de proyectos y métricas, respeta XDG_STATE_HOME |
| recordings/ | Historial audiovisual opcional, ignorado |

JARVIS_PROJECT_REGISTRY y JARVIS_TIMINGS_DIR permiten cambiar las ubicaciones del
registro y las métricas. Los clips adjuntos a una conversación nativa permanecen
con su historial; borrar grabaciones temporales no elimina esos adjuntos.
No compartas archivos de cuentas, perfiles, chats, capturas, .env.local o backups.
Solo abre proyectos de confianza: su configuración puede iniciar MCPs y ejecutar
herramientas autorizadas. Los servidores se enlazan a loopback.

Para otra instancia, elige PORT, OC_PORT y JARVIS_BRIDGE_PORT diferentes. Si
conectas un servidor externo, solo los puertos de interfaz y bridge son propios.
El lanzador limita el cierre a sus procesos hijos; el servidor externo continúa.

## Desarrollo y publicación

```bash
pnpm test
pnpm build
pnpm exec oxlint scripts/start-project.mjs scripts/start-project.test.mjs
# El auditor público examina lo agregado al índice de Git:
git add <archivos-revisados>
pnpm audit:publication
```

La suite usa concurrencia 2 para acotar las conversiones FFmpeg. Las pruebas
normales usan fixtures y servidores simulados; los smokes que arrancan clientes
nativos reales requieren activación explícita. No se necesita cuota de un modelo,
micrófono ni captura real para ejecutar la suite. Compilar no verifica el
reconocimiento real del navegador ni la compatibilidad de tu proveedor.
`pnpm dev` inicia solo Vite; evita ejecutarlo junto con pnpm start en el mismo puerto.

## Créditos y licencias

Aplicación derivada de [adewaskar/jarvis](https://github.com/adewaskar/jarvis),
MIT © 2026 Aditya Dewaskar. Se conserva su [licencia](LICENSE). Adaptación y
funciones de OpenCode, configuración e historial: Sergio Castro.
Organización de instrucciones inspirada en
[Mi-agente-agent-system](https://github.com/Cassers/Mi-agente-agent-system).
Las pistas de Kevin MacLeod tienen licencia CC BY 4.0: conserva los
[créditos completos](public/audio/CREDITS.md) al redistribuir o publicar vídeos.
