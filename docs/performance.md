# Medir esperas antes de optimizar

Abre **Rendimiento y tiempos** en el panel lateral. La instrumentación está activa mientras funciona la aplicación, aunque el panel esté cerrado. Elegir un flujo muestra sus etapas; el resumen compara mediana y p95 de muestras completadas. **Exportar mediciones** descarga JSON para analizarlas después.

Las mediciones no cambian pausas, modelos, prompts ni decisiones de captura. No requieren un modelo ni envían telemetría a un servicio externo. El clip solicitado por la propia conversación sigue su flujo normal.

## Cobertura y significado

| Flujo | Mediciones |
| --- | --- |
| Página | DOM y carga del documento; primeros dos fotogramas desde montar React; tareas largas cuando el navegador las soporta; saltos de animación superiores a 120 ms con la pestaña visible |
| Proyectos | HTTP de listado, apertura y selector de carpeta; catálogo y perfil visual; conexión y restauración del chat |
| Entrada de voz | Activar captura, primer reconocimiento disponible, cierre de intervención y ensamblado; continuación e interrupciones |
| Petición | Esperar conexión/selección; preparar, comprobar sesión, disponibilidad e historial; resolver capacidades; entregar mensaje a OpenCode |
| Clip directo | Resolver capacidades del modelo y convertir WAV a MP3; se adjunta a la conversación nativa, sin llamada previa de transcripción |
| Interrupción | Detener reproducción al detectar voz; esperar confirmación de abort nativo antes del siguiente envío (`turn.interrupt_wait`) |
| Monitor | Captura y adjunto de la pregunta; resultado alternativo si falla |
| OpenCode | Primer texto y respuesta terminada **observados por el bridge**; sincronización; conectar SSE; espera de eventos hasta iniciar sincronización; autorización pendiente; duración nativa de herramientas cuando OpenCode entrega inicio y fin |
| Salida de voz | Pregunta lista hasta primer sonido real de la respuesta; primer texto hasta sonido; cola, síntesis y reproducción de cada frase; salida y turno completos. Los mensajes de relleno no cuentan como primera respuesta hablada |
| Historial local | Activar/pausar, capturar y guardar fotogramas, publicar estado y limpiar archivos vencidos. No se inicia una grabación para medirla |

Las rutas HTTP del navegador miden hasta recibir cabeceras; la medida del bridge termina al enviar la respuesta. El selector de carpeta incluye tiempo humano. La sincronización sin una petición propia se muestrea una vez cada 30 s; durante una petición se mide cada sincronización. No se registra cada token ni cada fotograma normal del navegador.

La **duración del clip** indica cuánto audio se seleccionó, no cuánto tardó procesarlo. En audio directo, el VAD cierra cada segmento tras unos 650 ms de silencio o 6 s de voz continua. No se espera una pregunta completa. Si falta una captura íntegra o el modelo/ruta no acepta audio, aparece un error; el dictado visual nunca lo sustituye automáticamente. El modo «Solo transcripción» sigue disponible por elección explícita. Revisión y muestras del flujo anterior: [flujo de voz del 26 de octubre](voice-flow-review-2026-10-26.md).

Al volver a hablar, la página corta la lectura y pide interrumpir OpenCode; captura el siguiente segmento mientras espera esa confirmación. Los clips pendientes se conservan en orden; los que quedaron interrumpidos antes de enviarse se guardan con `noReply` sin pedir una respuesta intermedia. El siguiente clip entra en el mismo chat con una nota de continuación/corrección. `audio.queue` mide la espera para guardar clips anteriores. Si un envío anterior está cruzando HTTP, se espera el guardado del adjunto nativo antes del abort para evitar respuestas tardías. Un HTTP 204 de `prompt_async` no basta como confirmación: el mensaje todavía puede estar creándose. El audio directo se conserva en metadatos del historial nativo de OpenCode para poder continuar y reabrir chats; la retención de grabaciones de 30 minutos no elimina esos adjuntos del chat. No hay transcripción adicional ni archivos MP3 temporales en esta ruta. Los tiempos anteriores `audio.provider`, `audio.auth` y `audio.response` corresponden al flujo antiguo, no al nuevo.

La selección de un modelo ya cargado en la página se envía sin esperar otra
actualización del catálogo visual. El bridge valida el catálogo nativo actual en
cada pregunta. Las consultas de inspección de configuración/agentes/modelos/historial
se comparten solo dentro de esa pregunta, después de reparar el historial si fuera
necesario. No se cachean comprobaciones de pertenencia, estados, escrituras ni datos
entre preguntas o proyectos. Esto elimina consultas duplicadas antes del MP3 sin
cambiar las pausas de voz ni la elección nativa del modelo.

**No sumar etapas:** unas contienen otras y otras se solapan. Página y bridge usan relojes monotónicos independientes para calcular duraciones. La hora de pared sirve para ordenar aproximadamente, no para restar marcas de ambos procesos. La espera hasta el primer texto incluye OpenCode, proveedor, herramientas, permisos y transporte; no permite atribuir todo ese intervalo al modelo. Los tiempos internos de inferencia y del codificador de audio continuo no están expuestos por estas interfaces.

Los estados `error`, `timeout`, `cancelled`, `detached` y `fallback` aparecen separados y quedan fuera de los percentiles de muestras `ok`. Pocas muestras no constituyen una comparación fiable. Cerrar una vista produce `detached`: el trabajo nativo sigue su curso, aunque esta vista deje de medirlo.

## Registro local y privacidad

Cada registro contiene únicamente ID opaco de flujo y etapa, etiqueta fija, origen, estado, hora y duración. No se incluyen mensajes, nombres de proyectos, rutas, comandos de herramientas, modelos, URLs, claves ni contenido de audio/imagen. Los IDs permiten relacionar etapas de una intervención entre página y bridge; no se añaden al prompt de OpenCode.

Por defecto: `~/.local/state/mi-asistente/timings/` (respeta `XDG_STATE_HOME`). `JARVIS_TIMINGS_DIR` cambia el directorio; si se establece `JARVIS_PROJECT_REGISTRY`, usa `timings/` junto al registro. Archivos `timings.jsonl` y `timings.previous.jsonl`, de unos 2 MB cada uno, permisos 0600. El panel mantiene como máximo 2.000 etapas; al restaurar el registro se muestran las últimas 24 horas. Los archivos se rotan por tamaño, no se purgan por edad. No hay datos históricos anteriores a habilitar esta función.

Escritura asíncrona y colas acotadas: medir no espera al disco. El navegador envía pequeños lotes al bridge local. Si falla el guardado, conserva las muestras recientes en pantalla y muestra el problema; no reintenta ilimitadamente. La cola pendiente puede perderse si cierras la página inmediatamente. La observación tiene un coste pequeño propio: conviene contrastar las mediciones antes de cambiar el flujo.

## Verificación y unidades del cambio

1. Núcleo, validación y persistencia: `node --test bridge/timings.test.mjs scripts/timings-client.test.mjs`.
2. Conexión nativa y preparación: `node --test bridge/project-bridge.test.mjs bridge/voice-input.test.mjs` con proveedores y servidores simulados, sin cuota.
3. Entrada y salida: `node --test scripts/voice-timing.test.mjs scripts/speech-failures.test.mjs scripts/microphone.test.mjs scripts/listening-standby.test.mjs` con relojes y motores simulados.
4. Compilación: `pnpm run build`. Prueba visual local del panel con micrófono apagado; no produce consultas al modelo.

Para retirar esta función sin tocar datos nativos, quitar los observadores/importaciones de `timings` y `voice-timing`, el componente `TimingsPanel` y su montaje, y las rutas `/timings` del bridge. Los archivos de métricas son independientes de proyectos, conversaciones y grabaciones. No se ha creado un commit: el árbol contiene trabajo anterior del usuario.
