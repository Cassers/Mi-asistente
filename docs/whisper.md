# Whisper local

Whisper convierte un archivo de audio o una grabación elegida en texto en este
equipo. El cliente nativo recibe esa transcripción: no escucha el audio original.
El texto no conserva por sí solo timbre, entonación ni identidad de los hablantes.
No hay sustitución automática por ElevenLabs, reconocimiento del navegador ni
otro proveedor cuando Whisper falla.

## Usarlo desde la interfaz

En Configuración → Voz y permisos → Cómo enviar mi voz, elige **Whisper local**.
Elegir el motor no enciende el micrófono: actívalo con el control habitual cuando
quieras dictar. Si el motor no está disponible, la interfaz muestra la causa y
permite volver a comprobarlo, sin recurrir a otro servicio.

Para un archivo, pulsa **Adjuntar audio**, elige el archivo y espera la
transcripción completa. Revisa o edita el texto antes de pulsar **Enviar**. La
transcripción no envía el turno por sí sola; un error o reintento conserva el
borrador de texto existente. Los clientes Claude Code, Antigravity y Codex
reciben texto transcrito, no un adjunto de audio original.

## Preparar el motor

Requisitos: Git, CMake, compilador C/C++, FFmpeg y un modelo GGML de Whisper ya
disponible. La aplicación no descarga modelos. El modelo predeterminado se busca
en el directorio de datos XDG, en voxtype/models/ggml-large-v3-turbo.bin.
Puedes elegir otro con JARVIS_WHISPER_MODEL, una ruta absoluta de configuración
del servidor, nunca una ruta enviada por el navegador.

Ejecuta explícitamente uno de estos comandos:

- CPU: pnpm whisper:setup
- NVIDIA CUDA instalado: pnpm whisper:setup --cuda --jobs=2
- Arquitectura concreta, por ejemplo RTX 40: pnpm whisper:setup --cuda --cuda-arch=89 --jobs=2

El helper obtiene únicamente el repositorio oficial ggml-org/whisper.cpp,
release v1.9.5, commit d1be6fde11ac6e0407606b4e42fe72d34add8037. Verifica origen y
commit, conserva cambios existentes y compila solo whisper-cli con un máximo
de cuatro trabajos y un límite de treinta minutos para compilar. Un timeout se
muestra como tal y permite reanudar desde la caché. Cancelar detiene el grupo
propio de compiladores, sin afectar otros procesos. Guarda fuente, binarios y metadatos dentro de
.runtime/whisper.cpp/, excluido de Git. No instala nada global y no altera
voxtype, controladores ni configuraciones de cuentas. El arranque normal nunca
clona, compila ni descarga.

CC y CXX permiten seleccionar compiladores ya instalados; CUDAHOSTCXX selecciona
el compilador host de CUDA. En instalaciones Debian con CUDA distribuido bajo
/usr, pueden ser necesarios CUDAToolkit_ROOT=/usr y
CUDAToolkit_TARGET_DIR=/usr. Usa compiladores compatibles con tu toolkit:
no se fuerza la opción de compilador no soportado. Si falla CUDA, el helper
muestra el error; CPU se elige con un comando explícito.

El bridge busca JARVIS_WHISPER_CLI si está configurado; en caso contrario busca
.runtime/whisper.cpp/build/bin/whisper-cli y después whisper-cli en PATH.
JARVIS_WHISPER_FFMPEG permite indicar otro ejecutable FFmpeg. La comprobación
de disponibilidad revisa archivos/permisos y no ejecuta inferencia. No certifica
el contenido del modelo, dependencias dinámicas ni memoria GPU disponible;
esos fallos aparecen al transcribir y permiten reintentar.

## Contrato HTTP del bridge de proyectos

Las rutas se atienden después de las mismas comprobaciones Host, Origin y CORS
que el resto del bridge. No se amplía el límite JSON de /projects.

- GET /whisper devuelve engine: "whisper", available, model (solo nombre),
  reason cuando falta un recurso, maxBytes, maxSeconds y formatos MIME admitidos.
  Esta consulta nunca abre el micrófono ni inicia Whisper.
- POST /whisper/transcribe recibe bytes crudos de audio y Content-Type de audio.
  El único parámetro opcional es language=auto o un código Whisper, como es/en.
  No admite JSON, multipart, URLs, rutas de archivos ni compresión HTTP adicional.
- El éxito devuelve text, engine: "whisper", model y language cuando está disponible.
  La respuesta solo entrega texto al navegador; no envía automáticamente un turno.
- Los errores devuelven error en JSON: 400 solicitud/idioma vacío o inválido;
  408 carga lenta; 409 ocupado; 413 bytes/duración excesivos; 415 formato no
  admitido; 422 audio dañado, silencioso o sin palabras; 503 runtime no disponible;
  504 proceso excedió tiempo; 502 salida del motor inválida. No se devuelven
  diagnósticos que puedan contener audio, transcripciones o rutas privadas.

Formatos: WAV, MP3, FLAC, Ogg, WebM, MP4/M4A y AAC mediante sus tipos MIME de
audio anunciados por GET /whisper. Límite: 16 MiB y 120 segundos decodificados.
No se recorta silenciosamente un archivo largo. El umbral de energía rechaza
silencio/DC y clips demasiado débiles antes de inferencia; no es un clasificador
perfecto de voz y la precisión depende del audio/modelo.

## Procesos y datos temporales

Solo una operación puede estar activa; la siguiente recibe 409. Recibir el
cuerpo y decodificar tienen un límite de 15 segundos cada uno; Whisper tiene
180 segundos. Cancelar el fetch, desconectar el cliente o cerrar el bridge
cancela el proceso propio con SIGTERM y, si hace falta, SIGKILL tras 250 ms.
No se señalan otros procesos de Whisper, grabadores o aplicaciones.

El audio subido y el WAV mono PCM16/16 kHz se crean con nombres generados en
un directorio temporal 0700 y archivos 0600; la salida JSON queda dentro del
mismo directorio. Se eliminan al terminar, fallar o cancelar. No se guardan en
el historial, métricas ni logs generales. Un cierre forzado del sistema puede
dejar temporales: no se borran rutas ajenas automáticamente.

FFmpeg usa un demuxer explícito por MIME, protocolo de archivo local exclusivo,
stdin sin interacción y referencias externas MOV deshabilitadas. La entrada
temporal permite buscar dentro de M4A comunes cuyo índice está al final.
Ningún nombre/ruta proporcionado por el cliente se usa como argumento.

## Verificación

pnpm exec node --test bridge/whisper.test.mjs bridge/whisper-http.test.mjs

Las pruebas usan procesos y transcripciones sintéticos; FFmpeg real comprueba
WAV, WebM y M4A con índice final, sin invocar un modelo externo.

Smoke local opcional:
JARVIS_WHISPER_SMOKE=1 node --test bridge/whisper-smoke.test.mjs

Necesita el motor/modelo ya preparados y espeak-ng. Genera voz sintética local,
la transcribe con el Whisper instalado y elimina los archivos. No usa micrófono,
pantalla, cuentas ni proveedores. No demuestra precisión general.

## Fuentes

- [Release oficial fijado](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5).
- [Build y CUDA de whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/v1.9.5#nvidia-gpu-support).
- [CLI: modelo, idioma, WAV y salida JSON](https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/cli/README.md).
- [Protocolos FFmpeg](https://ffmpeg.org/ffmpeg-protocols.html#Protocol-Options).
- [Demuxer MOV y referencias externas](https://ffmpeg.org/ffmpeg-formats.html#mov_002fmp4_002f3gp).
