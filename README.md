# Mi asistente

Una aplicación local para conversar por voz con tu asistente personal mediante
OpenCode. El nombre, estilo y trato se eligen en la primera conversación: no
viene con una identidad fija. Pensada para instalaciones individuales, también
para estudiantes; no es un servidor multiusuario.

## Empezar

Requisitos: **Node.js 22.12 o superior**, **pnpm 11**, Git y Google Chrome con
micrófono permitido. La captura y el historial requieren **Linux + niri/Wayland**,
`grim`, `ffmpeg` con PulseAudio/Opus y `pactl` (PipeWire-Pulse también sirve).
Sin esas herramientas, deja las capturas y el historial apagados.

```bash
git clone https://github.com/Cassers/Mi-asistente.git
cd Mi-asistente
pnpm install --frozen-lockfile
pnpm run setup
pnpm start
```

Abre **http://127.0.0.1:5173 en Google Chrome**, pulsa el control inicial para
activar audio y permite el micrófono. El asistente te preguntará cómo quieres
llamarlo y su estilo. Confirma sus elecciones y la escritura de configuración.
Antes de elegir nombre se activa con «asistente». Después usa el nombre elegido
o Espacio. **Ctrl+C en la terminal detiene esta instancia**.

Si necesitas conectar tu propio proveedor:

```bash
pnpm run opencode -- auth login
```

El comando usa el mismo OpenCode y las mismas carpetas aisladas que la app.
No copia la cuenta ni las claves de otra instalación. El modelo inicial es
DeepSeek Flash Free, sujeto a disponibilidad y límites de OpenCode. Si no está
disponible, conecta un proveedor y elige un modelo en el panel; no se cambia
automáticamente a uno de pago. Tener una suscripción no garantiza compatibilidad
de todos los modelos o herramientas.

## Qué incluye

- Interfaz React/Three.js con conversación desplazable, texto enriquecido y
  fondo legible. La voz omite Markdown, flechas, código en bloques y «???».
- Voz del navegador, selector de voz y velocidad de 0.5 a 2×. La pausa
  conversacional se reactiva diciendo el nombre, con Espacio o con el botón.
- OpenCode local: búsqueda de modelos por nombre/proveedor, modelos gratuitos
  y de pago de proveedores conectados, y niveles de pensamiento reales cuando
  el modelo los ofrece. No inventa niveles ni cambia de modelo solo.
- Un chat por sesión, conversaciones guardadas y posibilidad de retomarlas.
- Identidad, usuario, memoria y habilidades editables en archivos `AGENTS.md`
  y `ME/`. Fecha/hora se añaden al mensaje, no al encabezado estático.
- Captura actual del monitor por pregunta para modelos con visión, opcional.
- Historial local opcional: objetivo de 2 capturas/segundo y audio de micrófono
  y PC en pistas separadas de 10 segundos, con retención de 30 minutos mientras
  el servicio está activo. Su ritmo efectivo depende del equipo.
- Revisión bajo demanda del historial; el audio nativo usa un helper MiMo Free
  con comprobación de coste cero, sin fallback de pago. Es experimental: el
  proveedor puede rechazar adjuntos incluso si el catálogo anuncia audio.
- Permisos visibles: Manual por defecto, Limitado para lecturas concretas del
  perfil y Total con advertencia. No se guardan aprobaciones permanentes;
  cada nueva conexión vuelve a Manual y se respetan los rechazos nativos.

## Orquestador opcional

La instalación normal usa el asistente básico. Para añadir el sistema de
[Mi-agente-agent-system](https://github.com/Cassers/Mi-agente-agent-system):

```bash
pnpm run harness:install
```

Requiere Git e Internet. Descarga una **revisión fija**, incorpora protocolo,
plantilla de agentes y skills, y registra **arquitecto-skills** como subagente
nativo de OpenCode. No sustituye tu nombre, estilo, memorias o credenciales ni
ejecuta instaladores del repositorio de origen. Reinicia `pnpm start` para cargarlo.

```bash
pnpm run harness:install -- --status
pnpm run harness:install -- --disable
```

Desactivar conserva los documentos y memorias; no vuelve a activarse al arrancar
normalmente. Repetir la instalación activa no sobrescribe tus personalizaciones.
Los conflictos con archivos/agentes existentes se informan para resolverlos a
mano. El módulo no se actualiza automáticamente con cada cambio del upstream.

Build sigue atendiendo la conversación y delega trabajos pertinentes, no saludos
ni la primera configuración. Los agentes heredan el modelo elegido, sin fallback
de pago. Las delegaciones pueden aumentar tiempo/tokens y dependen del soporte
de herramientas del proveedor, incluso en modelos gratuitos. Sus permisos se
muestran en el mismo chat, manteniendo la confirmación nativa.

Más detalles, límites y cómo registrar otros agentes en
[la guía del orquestador](docs/optional-harness.md).

## Activar pantalla e historial

Ambos vienen **apagados por privacidad**. Copia `.env.example` a `.env.local` y
edita solo lo necesario:

```dotenv
# Una captura del monitor principal en cada pregunta después del alta:
JARVIS_AUTO_SCREEN=1
# Historial continuo opcional (también se controla con REC en la interfaz):
JARVIS_RECORDING=0
```

Reinicia `pnpm start` después de cambiar el archivo. Los identificadores
`JARVIS_*` y `jarvis_desktop_*` son compatibilidad interna, no el nombre del
asistente. El backend resuelve monitores activos mediante niri; revisa la imagen
elegida antes de usarlo con información sensible.

**Pausar la conversación NO apaga físicamente el micrófono**: sigue escuchando
para reconocer el nombre. El grabador del historial es independiente. Para
silencio total, pausa REC y revoca el permiso de micrófono o usa su interruptor
físico; ya no podrá despertarse por voz.

## Tus archivos y privacidad

| Carpeta | Contenido |
| --- | --- |
| `templates/` | Plantillas genéricas versionadas; no contienen tu perfil |
| `opencode/workspace/` | Instrucciones activas, `ME/CONFIG.json` y memorias propias |
| `opencode/workspace/.jarvis/` | Registro privado de conversaciones |
| `opencode/data/`, `xdg/`, `state/`, `cache/` | Credenciales, sesiones y runtime de OpenCode |
| `recordings/` | Capturas y clips locales del historial |

Todos los datos de ejecución están ignorados por Git. `pnpm run setup` crea lo que
falta y **no sobrescribe** tu configuración ni tus memorias. Si mueves la carpeta
de instalación, revisa la ruta del MCP en `opencode/xdg/opencode/opencode.json`.
Cambiar plantillas no reemplaza silenciosamente instrucciones de instalaciones
existentes; edita los archivos activos para personalizar tu instancia.

Los archivos de instrucciones se envían al modelo como contexto. Guardarlos en
un archivo ayuda a organizarlos y mantenerlos estables, pero no elimina tokens ni
garantiza caché. Las capturas y los clips revisados se envían a OpenCode y a su
proveedor: no uses datos privados de estudiantes ni de terceros sin consentimiento.
El reconocimiento del navegador también puede enviar voz al servicio del
navegador; no es una solución completamente sin nube.

No compartas `opencode/`, `.env.local`, grabaciones, perfiles ni backups. Cada
estudiante debe clonar el repo y conectar su propia cuenta. Los servidores se
enlazan a loopback; **no los expongas a Internet ni uses `--host 0.0.0.0`**.
El modo Total puede ejecutar comandos con los permisos de tu usuario; úsalo
únicamente con contenido de confianza. No es una sandbox de sistema operativo.

## Límites y diagnóstico

- Solo OpenCode está integrado en el flujo principal. Hay código heredado del
  proyecto original para otros backends, pero no se activa con `pnpm start`.
- Incluye búsqueda/lectura web y MCP de escritorio; **no incluye un conector
  configurado para controlar pestañas, hacer clics o automatizar el navegador**.
  Abrir Chrome por un comando autorizado no equivale a controlarlo.
- Opera GX y navegadores integrados pueden no ofrecer reconocimiento de voz.
  Prueba Chrome antes de cambiar el modelo. `D` muestra diagnóstico y `T` prueba voz.
- Un nivel de pensamiento alto, imágenes, permisos pendientes y el proveedor
  pueden aumentar la demora. No hay promesa de respuesta instantánea.
- Si un puerto está ocupado, el arranque falla sin detener el proceso ajeno.
  Para otra instancia, cambia `PORT`, `OC_PORT` y `JARVIS_BRIDGE_PORT` a puertos
  distintos en `.env.local`; cada clon debe tener sus propias carpetas runtime.
- La retención necesita el servicio activo. No ofrece borrado seguro del disco
  ni elimina copias que hayas hecho fuera de la carpeta de grabaciones.

## Desarrollo

```bash
pnpm test
pnpm build
pnpm exec oxlint scripts/setup.mjs scripts/start.mjs scripts/opencode.mjs scripts/package.test.mjs
# Antes de publicar cambios, revisa lo que agregaste al índice:
git add <archivos-que-quieras-publicar>
pnpm audit:publication
```

`pnpm dev` inicia solo Vite; `pnpm start` levanta el sistema completo. No ejecutes
ambos sobre el mismo puerto. Los tests de integración usan un OpenCode ficticio:
no consumen modelos ni activan cámara, pantalla o micrófono. Compilar no confirma
que tu navegador o proveedor admitan audio; prueba esos permisos en tu equipo.

## Créditos y licencias

Aplicación derivada de [adewaskar/jarvis](https://github.com/adewaskar/jarvis),
MIT © 2026 Aditya Dewaskar. Se conserva su [licencia](LICENSE). Adaptación y
funciones de OpenCode, configuración e historial: Sergio Castro.
Organización de instrucciones inspirada en
[Mi-agente-agent-system](https://github.com/Cassers/Mi-agente-agent-system).
Las pistas de Kevin MacLeod tienen licencia CC BY 4.0: conserva los
[créditos completos](public/audio/CREDITS.md) al redistribuir o publicar vídeos.
