# Clientes nativos: Claude Code y Antigravity

En Configuración → Aplicación, elige el cliente instalado y abre una carpeta de
confianza. Mi-asistente conserva cuentas e instrucciones nativas; no introduce
una personalidad ni copia credenciales. Abrir una carpeta no activa voz, pantalla
ni grabación. Las aplicaciones no instaladas aparecen como no disponibles, con
la causa. La detección comprueba el ejecutable; no confirma una suscripción ni
consume inferencia. Si falta autenticación, inicia sesión en el cliente nativo.

| Función | Claude Code | Antigravity CLI (`agy`) |
| --- | --- | --- |
| Transporte | Claude Agent SDK sobre el ejecutable local | NDJSON oficial de la CLI local |
| Texto escrito y dictado | Sí | Sí |
| Clips de audio directo | No; solo transcripción explícita | No; solo transcripción explícita |
| Compartir pantalla | Imagen nativa con elección explícita; el proveedor puede rechazar modelos incompatibles | No disponible: la entrada programática admite solo texto |
| Contexto de carpeta | `cwd`, preset nativo `claude_code`, configuración de usuario/proyecto/local | `cwd` y reglas nativas de `agy` |
| Conversaciones | Historial nativo del directorio exacto, sin incluir otros worktrees | Conversaciones iniciadas desde Mi-asistente y su ID nativo para continuar |
| Reconectar/interrumpir | El runtime conserva el trabajo y las solicitudes; detener cancela el proceso de ese turno | El runtime conserva el trabajo; detener señala únicamente su proceso propio |
| Permisos | Solicitudes nativas al panel, con decisiones explícitas y preguntas separadas | Reglas nativas; las operaciones que requieren preguntar se rechazan en headless |
| Modelos/pensamiento | Catálogo del SDK; elección explícita validada | Predeterminados nativos; no se inventa un catálogo |
| Borrar/archivar | Gestionar desde el cliente nativo | Gestionar desde el cliente nativo |

La actividad mostrada corresponde al runtime de Mi-asistente. No hay una API
común de estado para bloquear ediciones concurrentes iniciadas desde otros
clientes Claude/Antigravity; evita trabajar simultáneamente en el mismo hilo.
La configuración de permisos nativa sigue vigente: sus preautorizaciones pueden
resolver operaciones antes del panel y sus denegaciones no se convierten en
permisos por elegir un modo automático aquí. Al conectar o desconectar una vista,
el panel vuelve a Manual y conserva solicitudes pendientes para reconectar.

Claude carga las instrucciones de la carpeta mediante su preset de CLI y
`settingSources: ['user', 'project', 'local']`. No reutiliza el `systemPrompt` ni
el directorio fijo del antiguo `bridge/server.mjs`. El SDK se usa desde la
dependencia existente; no hace falta instalar otro paquete en este proyecto.

Antigravity no se suplanta con Gemini ni con otro proveedor. La interfaz CLI
seleccionada conserva el login local. El SDK Python de Antigravity y el agente
cloud son otras interfaces, con configuración y autenticación distintas; no se
usan como sustitutos silenciosos. Tampoco se importan las conversaciones del IDE
mediante bases internas o protocolos no documentados.

Si usas rutas de instalación no presentes en `PATH`, configura explícitamente
`JARVIS_CLAUDE_CLI` o `JARVIS_ANTIGRAVITY_CLI` al arrancar el puente. Cambiar esos
valores no instala software ni modifica la configuración global del cliente.

## Privacidad y estado

Compartir pantalla sigue apagado por defecto y se revoca al cambiar realmente de
aplicación, carpeta o conversación, y al desconectar. La transición inicial de
chat vacío a `ready` conserva una elección explícita de esa misma vista.
`applicationCapabilities` se acepta solo del `ready` del socket actual; un valor
desconocido no concede compartir pantalla. Antigravity anuncia
`screenOptIn: false`. Un mensaje que exija una imagen en esa ruta falla antes de
enviar texto o capturar, en lugar de omitir el adjunto.

El historial local de pantalla/sonido se controla por separado. Mantiene sus
confirmaciones correlacionadas y el control de micrófono de la versión anterior.
Apagar el micrófono no permite que una reconexión use una capacidad antigua para
volver a grabarlo. La preferencia de audio directo de OpenCode se conserva;
Claude, Codex y Antigravity reciben solo texto transcrito, mediante dictado del
navegador o [Whisper local](whisper.md) elegido explícitamente, sin reutilizar
clips o subtítulos de una aplicación anterior. Whisper convierte el archivo o
grabación a texto en este equipo; no añade audio original al cliente nativo.

## Evidencia y límites de validación

Interfaces instaladas inspeccionadas el 28 de octubre de 2026: Claude Code
2.1.301, Claude Agent SDK 0.3.301 y Antigravity CLI 1.4.4. Se consultaron `--version`
y `agy --help`; este último anuncia `--input-format`, `--output-format` y
`--conversation`. Su ayuda de modelos no ofrece un contrato JSON estable, por
lo que el selector conserva el modelo nativo predeterminado.

Las pruebas de proceso usan ejecutables sintéticos y el SDK real para comprobar
el protocolo, contexto, permisos, aislamiento y continuación. El smoke opcional
`JARVIS_CLAUDE_NATIVE_SMOKE=1 node --test bridge/claude-native-smoke.test.mjs`
ejecuta Claude Code instalado con HOME/configuración temporales y un servidor
Anthropic Messages exclusivamente en `127.0.0.1`: verifica texto original, PNG
sintético real, AGENTS de prueba y el mismo ID al continuar. No utiliza cuentas
reales, micrófono, escritorio ni proveedores externos. Antigravity se valida con
su protocolo documentado y un proceso de prueba local; no se hizo inferencia con
la cuenta del usuario.

## Referencias oficiales

- [Claude Agent SDK: TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript).
- [Sesiones del SDK](https://code.claude.com/docs/en/agent-sdk/sessions): identificación, continuación y APIs de historial.
- [Preset y configuración nativos](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts): el SDK sin preset no equivale al prompt de Claude Code.
- [Aprobaciones y preguntas](https://code.claude.com/docs/en/agent-sdk/user-input): `canUseTool` y límites frente a reglas previas.
- [Antigravity CLI headless](https://antigravity.google/docs/cli/headless/): stream JSON, texto admitido, continuidad y permisos no interactivos.
- [Conversaciones Antigravity](https://antigravity.google/docs/cli/conversations/): alcance del directorio y reanudación.
- [Referencia CLI](https://antigravity.google/docs/cli/reference/): flags y configuración del cliente.
- [SDK Python Antigravity](https://antigravity.google/docs/sdk/overview/): interfaz distinta, API key o Vertex.
