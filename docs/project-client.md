# Abrir proyectos reales con Codex y OpenCode

La página es un cliente de voz y texto de Codex y OpenCode. El proyecto es una carpeta real,
La aplicación elegida guarda las conversaciones y resuelve sus instrucciones,
agentes, skills, MCPs y permisos. No se copia el proyecto ni se escribe un prompt paralelo.

## Uso previsto

1. Arrancar la interfaz y elegir Codex u OpenCode con su cuenta ya configurada.
2. Elegir una carpeta con el selector nativo o escribir su ruta absoluta.
3. Elegir una conversación nativa existente o crear una nueva.
4. Escribir o usar el dictado del navegador; la captura es opcional. El texto y
   los eventos vienen de la sesión nativa de la aplicación elegida.

## OpenCode: requisitos y decisiones

- Al abrir una carpeta se valida su ruta real y su directorio en OpenCode.
- Todas las operaciones y eventos llevan el contexto del proyecto seleccionado.
- La lista de chats se consulta a OpenCode y se filtra por directorio exacto;
  no se usa una lista privada de chats exclusivos de la página.
- Abrir, cerrar o cambiar de conversación no aborta ni elimina trabajo nativo.
  Solo «Detener respuesta» interrumpe la sesión seleccionada.
- Los mensajes externos también se reflejan en pantalla. Un único historial
  nativo evita duplicar entradas optimistas de la interfaz.
- El modelo/agente por defecto procede de OpenCode. Las elecciones explícitas
  de la interfaz pertenecen a cada proyecto y nunca activan un fallback de pago.
  Al retomar un chat se conservan su último agente (incluido `plan`), modelo y
  variante nativos; un chat vacío hereda los predeterminados del proyecto.
- El proyecto recibe únicamente el mensaje y los adjuntos habilitados; no se
  inyecta identidad, instrucciones de bootstrap ni rutas de memoria de Jarvis.
- La cabecera y el nombre de activación prefieren `ME/IDENTITY.json` cuando contiene
  una identidad válida; después usan `ME/CONFIG.json` si define un nombre y,
  en su ausencia, el campo explícito `Nombre` de `ME/IDENTITY.md`. Solo se
  expone el nombre, sin el contenido del archivo ni sus instrucciones. Los emojis
  y aclaraciones entre paréntesis no forman parte del nombre hablado. Si ninguno
  existe, se muestra «Asistente». El cliente no escribe esos archivos.

Formato estructurado opcional (`ME/IDENTITY.json`):

```json
{
  "version": 1,
  "name": "Narya",
  "wakeWord": "Narya",
  "language": "es-CO",
  "style": "Directa, juguetona y clara"
}
```

El JSON define metadatos visibles, no reemplaza por sí solo las instrucciones que
OpenCode carga. Para migrar la identidad completa de un proyecto, sus instrucciones
en `AGENTS.md` deben referenciar el archivo nuevo. La compatibilidad no renombra,
reescribe ni elimina la identidad Markdown existente.
- Los proyectos recientes se guardan fuera del proyecto. No se guardan claves
  del servidor en el navegador ni en ese registro.
- Servidores permitidos: HTTP de loopback. El puente controla Origin y no sigue
  redirecciones al reenviar credenciales. Elegir un proyecto permite que OpenCode
  cargue su configuración/MCPs: abrir solo carpetas de confianza.

## Unidades de trabajo

1. Adaptador local/proyectos y sesiones nativas, con pruebas de aislamiento.
2. Selector de proyectos y conexión, preferencias por proyecto e historial nativo.
3. Arranque sin workspace/prompt impuesto, integración y documentación de uso.

## Verificación

Pruebas con dos carpetas y servidores simulados: chats separados, sesión ajena
rechazada, no abort/delete al desconectar, eventos y permisos aislados, errores
explícitos, sin prompts añadidos ni contraseñas persistidas. Smoke con OpenCode
real en carpetas temporales: resolución de configuración/AGENTS y conversaciones
sin inferencia ni audio/capturas privados. Build, lint y QA visual del selector.

```sh
node --test --test-concurrency=2 scripts/*.test.mjs bridge/*.test.mjs
JARVIS_NATIVE_SMOKE=1 node --test bridge/project-native-smoke.test.mjs
pnpm run build
```

La segunda prueba inicia un OpenCode real aislado y un MCP de fixture en carpetas
temporales; no llama a ningún modelo ni usa claves o archivos personales.

## Codex: conexión nativa

El puente inicia `codex app-server --listen stdio://` en la carpeta elegida.
Usa la cuenta, CODEX_HOME, configuración e instrucciones nativas; no impone un
prompt de identidad ni cambia el sandbox o los permisos del proyecto.
La carpeta puede registrarse en ambas aplicaciones: cada una conserva sus chats,
modelos y preferencias por separado. El selector muestra el catálogo y los niveles
de pensamiento disponibles en Codex; «Predeterminado del proyecto» conserva la
decisión nativa en vez de forzar un modelo.

Las respuestas llegan en streaming. Las aprobaciones y preguntas del agente se
muestran en la interfaz. Cerrar o minimizar la vista no detiene el turno;
«Detener respuesta» sí solicita su interrupción. Archivar usa el archivo nativo
recuperable. Codex materializa una conversación nueva tras el primer mensaje:
un chat vacío puede no aparecer en el historial al reiniciar el servidor.

Codex usa exclusivamente «Solo transcripción» en esta interfaz: reconoce voz
mediante el dictado del navegador y envía únicamente texto. Audio directo aparece
deshabilitado, incluso si el navegador guardaba esa preferencia o el modelo
anuncia audio. El cambio se aplica también a la captura y al envío, no solo al
selector. Texto escrito y lectura de respuestas siguen disponibles.

Cambiar a Codex reinicia la entrada de voz de forma segura y descarta callbacks
tardíos de clips anteriores. Esos clips y sus subtítulos no se convierten en
mensajes de dictado nuevos. Volver a OpenCode restaura su elección guardada de
audio directo o transcripción; usar Codex no modifica esa preferencia.

### Transporte nativo conservado para desarrollo

El transporte interno de audio de CLI 0.159.0 sigue en el runtime y en sus pruebas,
pero no está expuesto por el cliente Codex. Su socket anuncia audio directo
deshabilitado y rechaza clips, preserveOnly y overrides de modo directo. Lo que
sigue describe esa implementación interna, no una función habilitada en la UI.

El 28 de octubre de 2026, los ocho modelos disponibles en la cuenta comprobada
anunciaban únicamente texto e imagen: la ampliación del cliente no habilita
audio en esos modelos. La disponibilidad depende de tu catálogo y proveedor.
Un probe de arranque realtime nativo, sin enviar audio, recibió después del acuse
el evento `realtime conversation requires API key auth` con esa autenticación.
La ruta realtime no está integrada como alternativa automática.

Cada clip se valida como WAV mono PCM de 16 kHz y se guarda como data URI en el
mismo hilo mediante `thread/inject_items`, con rol de usuario. Después,
`turn/start` inicia la respuesta con el contexto y las herramientas nativas.
No hay otro servicio de transcripción, API key adicional, cambio de modelo,
prompt de sistema añadido ni fichero temporal del que dependa la reanudación.
`preserveOnly` guarda el fragmento sin generar respuesta; una interrupción
durante la preparación espera ese guardado antes de confirmar la detención.
Los siguientes fragmentos conservan su audio original y una nota de continuación
o corrección. Silenciar el micrófono y detener la respuesta siguen separados.

Codex conserva los items raw añadidos sin respuesta en el contexto persistido
del modelo, aunque su paginación pública no los muestra como turnos autónomos.
El cliente muestra un marcador de audio mientras permanece conectado; después
de reconectar, esos marcadores de prefijos pueden no aparecer aunque el modelo
siga recibiendo el audio. Los turnos iniciados sí mantienen su historial normal.

Si se pierde la confirmación de un append, el cliente no afirma que el audio se
haya guardado ni lo reenvía automáticamente. Se bloquea más audio en esa vista.
Un mensaje de texto explícito verifica pertenencia, estado e historial legible
del hilo y permite continuar sin reenviar el clip incierto. Los RPC públicos no
permiten distinguir con certeza un append raw confirmado en servidor de otro
que nunca llegó; la recuperación no promete haber determinado ese estado.

La integración se verificó con CLI 0.159.0, dos turnos, recuperación de historial,
AGENTS.md, aprobaciones y cierre de MCPs usando un proveedor local de prueba;
no valida una llamada real a tu proveedor ni el micrófono del navegador.

El smoke opt-in de audio usa el binario real, ondas y catálogo de capacidades
sintéticos, y un servidor Responses local simulado. Verifica append sin
inferencia, prefijo + continuación en orden, reinicio y reanudación, AGENTS,
herramienta nativa, `Audio`/`LocalAudio` de `turn/start`, y confirmaciones
perdidas con y sin append real. No prueba comprensión de voz de un proveedor
real ni acceso de tu cuenta a un modelo de audio. Ejecútalo con:

```sh
JARVIS_CODEX_NATIVE_SMOKE=1 node --test --test-concurrency=1 bridge/codex-audio-native-smoke.test.mjs bridge/codex-native-smoke.test.mjs
```

## Compatibilidad y recuperación

El puente anterior permanece en `bridge/opencode-bridge.mjs` como compatibilidad.
El nuevo arranque usa `bridge/project-bridge.mjs`. Los proyectos y chats anteriores
no se borran. Volver al puente anterior no revierte ni elimina conversaciones nativas.
Codex usa su CLI app-server por stdio con cuenta, configuración y conversaciones
nativas. Sus capacidades de audio, modelos y permisos se validan por separado;
no se les aplican los plugins de OpenCode.

Las memorias y skills deben usar las convenciones o referencias que reconozca
la versión de OpenCode; una carpeta con ese nombre no garantiza su carga.
Cerrar la página no equivale a detener un servidor iniciado manualmente.
