# Integridad del audio y esperas observadas

Se reportó que el mensaje interpretado conservaba solo el final de su intervención. Se revisó la captura, los límites de frase y las mediciones locales. El clip real no se conserva en disco: no fue posible volver a escucharlo ni demostrar qué dijo exactamente. Las regresiones se reprodujeron con PCM y reconocimiento simulados, sin consumir cuota ni activar su micrófono.

## Correcciones

- El límite de captura se establece al entrar en escucha; el audio no depende solo de un aviso tardío de Web Speech con dos segundos de recuperación. Se conserva el inicio y los segmentos de la misma intervención.
- El audio se acota a 60 segundos. Si se perdió un prefijo, la selección es ambigua o se supera ese límite, se usa el dictado disponible en vez de enviar la última parte como si fuera la intervención completa. La duración y el resultado quedan en las mediciones; la duración del clip **no es una espera**.
- Al detectar nombre y pregunta en una transcripción parcial, se espera su final antes de enviarla. El nombre solo mantiene la activación breve existente.
- Retomar una cláusula suspende el temporizador de la parte anterior; no se dispara mientras la persona sigue hablando. Las conjunciones españolas mantienen una frase incompleta en espera.
- Se respeta la actividad de voz del navegador aunque pasen más de 900 ms sin texto nuevo. El watchdog conserva un techo de recuperación para un reconocedor atascado.
- Una continuación vacía o fallida en la ruta VAD no deja una cláusula anterior retenida indefinidamente: vuelve a asentarse cuando la captura y su cola están quietas.
- Apagar el micro sigue siendo independiente de detener la respuesta. No se cambian el modelo elegido ni su nivel de pensamiento.

## Muestras reales anteriores a la corrección

Se deduplicaron los registros JSONL por origen e ID. Hay **tres turnos completados** útiles; no es una comparación estadística estable. Los intervalos siguientes proceden de esas tres muestras y omiten errores/cancelaciones.

| Etapa | Intervalo observado |
| --- | ---: |
| WAV → MP3 | 0,124–0,140 s |
| Proveedor: transcribir MP3 | 1,319–3,440 s |
| Preparación e interpretación de audio, completa | 2,220–4,343 s |
| Capturar y adjuntar monitor | 0,279–0,285 s |
| Preparación total en bridge | 3,463–5,421 s |
| OpenCode: primer texto observado | 3,185–4,095 s |
| Primer texto suministrado al lector → primer sonido | 0,355–5,993 s |
| Pregunta lista → primer sonido | 7,019–13,698 s |
| Turno hasta terminar la lectura | 53,267–89,538 s |

Un turno cancelado después de empezar a hablar tardó **18,662 s hasta el primer texto observado de OpenCode** y **24,646 s hasta el primer sonido**. Se muestra como caso lento, pero no entra en los rangos de turnos completados.

La conversión a MP3 no domina estas muestras. La llamada adicional de audio y la espera de OpenCode tienen más peso. Hay además un caso de casi seis segundos entre el primer texto entregado al lector y su primer sonido: ese intervalo incluye esperar una unidad de texto pronunciable/cola, no únicamente el arranque del motor de voz. La lectura completa puede durar más de un minuto porque la respuesta es larga; eso no equivale a un minuto sin respuesta.

No sumar filas: preparación contiene audio/captura, las lecturas se solapan con generación y los puntos de inicio difieren. Las duraciones de OpenCode son observadas desde fuera e incluyen posibles herramientas, permisos y transporte. No se puede atribuir ese tiempo exclusivamente al proveedor del modelo.

## Próximas comparaciones

### Actualización: audio directo por pausas

El modo predeterminado ahora envía cada segmento de voz directamente al modelo de la conversación. No llama antes a un transcriptor. El dictado opcional del navegador solo muestra subtítulos y detecta el nombre de activación. El VAD local cierra el clip tras unos 650 ms de silencio o 6 s de voz continua; el modelo puede responder a cada clip. Si la persona continúa, se corta la lectura, se solicita abort nativo y el siguiente audio llega al mismo chat con una nota de continuación/corrección. Apagar el micrófono sigue siendo una acción independiente.

OpenCode 1.19.3 necesita un adaptador para transportar estos MP3 en las rutas compatibles de OpenCode/OpenCode Go y Google. El lanzador carga un plugin local durante el arranque sin reescribir AGENTS ni la configuración de los proyectos. El plugin guarda el audio en metadatos del historial nativo, fuera del texto tokenizado, y lo incorpora a la petición del proveedor conservando herramientas, agente, instrucciones, modelo y pensamiento. Los títulos y la compactación auxiliar reciben una etiqueta de audio sin transcripción. Al compactar, esos resúmenes no pueden recuperar por sí solos los detalles de audios que nunca llegaron a describirse en texto.

El modo directo exige capacidad de audio y una ruta compatible; falla explícitamente si faltan. No sustituye silenciosamente el audio por dictado. Cada clip es una petición independiente y los audios previos forman parte del historial: no es una sesión de audio en streaming. El adjunto nativo permanece con el chat; no comparte el borrado de grabaciones a los 30 minutos.

El adaptador conserva referencias de audio en RAM hasta que OpenCode libera la instancia del proyecto o se reinicia el servidor. Esto permite peticiones concurrentes y reintentos sin perder adjuntos; el consumo de memoria crece con los clips usados. No impone un tope de clips que impida abrir o compactar un historial ya guardado. Los límites del contexto y de entrada del proveedor siguen aplicándose.

La prueba aislada usa OpenCode real con un proveedor simulado: verifica instrucciones del proyecto, envío de audio real en el cuerpo HTTP, una herramienta nativa y el paso posterior con su resultado. Las regresiones verifican los límites PCM, el navegador sin dictado y la confirmación de interrupción antes de enviar el siguiente audio. No se activó el micrófono ni se consumió cuota. Los rangos anteriores describen el flujo antiguo: todavía falta medir una conversación real para cuantificar la reducción de espera.

## Prueba real posterior: pérdida al interrumpir y demora

Las mediciones de la prueba del usuario revelaron una pérdida en la aplicación: un clip de 20.133 ms se canceló durante la preparación (135 ms en la comprobación de sesión), antes de entrar en OpenCode. Solo se envió el siguiente clip de 5.803 ms. Esa respuesta tardó 2.532 ms en preparación, 9.534 ms desde entrega a OpenCode hasta primer texto observado y unos 473 ms desde texto al sonido: 12.558 ms hasta primer audio. Incluye herramientas y transporte; no atribuir todo el intervalo al proveedor. Los clips anteriores cancelados antes de persistir no se pueden reconstruir desde las métricas.

Corrección: la interrupción por nueva voz conserva los clips directos que todavía se están preparando. Se guardan mediante la ruta nativa síncrona de mensajes con `noReply: true`, sin transcribir ni generar una respuesta obsoleta. Los envíos normales confirman que el adjunto ya está en el mensaje nativo antes de permitir un abort; el HTTP 204 asíncrono por sí solo no confirma persistencia. La cola de la página conserva cada clip en orden incluso si esperaba conexión, selección o confirmación de stop cuando volvió la voz. Cambiar de proyecto/chat sigue separando las colas.

El límite por segmento directo baja de 20 a 6 segundos; la pausa sigue en unos 650 ms. Esto acota la espera cuando el ruido reinicia repetidamente el detector de silencio, conservando todas las partes en el historial. Las consultas independientes de configuración, agentes y catálogo se precargan juntas dentro de cada intervención. No se cambia el modelo ni las instrucciones del proyecto.

Verificación: la prueba con OpenCode real y proveedor simulado comprueba que `noReply` guarda el prefijo sin llamadas al modelo, que la respuesta siguiente recibe ambos audios y que tras reiniciar el servidor siguen los tres clips en orden. Los tests con servidor simulado retienen la inspección de modelo mientras llega la interrupción, y comprueban el guardado del clip previo antes de confirmar stop. No se activó el micrófono ni se consumió cuota en estas pruebas.

## Dictado: reconocimiento rápido y cierre que no llega

Al volver a Solo transcripción, las muestras de 16:49–16:52 muestran reconocimiento de 243–409 ms, seguido por intervenciones canceladas a los 19–22 s sin una petición al bridge. El navegador mostraba «Hola» en el subtítulo y la página seguía en LISTENING. El controlador esperaba `onspeechend` mientras `speechActive` seguía verdadero; el resultado ya reconocido no bastaba para salir de esa espera.

En un intento que sí se envió hubo 17.264 ms de entrada de voz, 1.013 ms de cierre observado y 250 ms de ensamblado. Después: 915 ms de preparación, 20.985 ms de OpenCode hasta primer texto y unos 338 ms adicionales hasta primer audio. El saludo completo tardó 22.254 ms desde que estuvo listo para enviarse; no atribuir esos 21 s de espera nativa al cierre del dictado.

La salida manual «Enviar texto» o Enter debe comprometer únicamente las palabras pendientes dentro del reconocedor; nunca reenviar el subtítulo, que también puede contener estados de la aplicación. Se habilita mientras escucha en Solo transcripción, con micrófono encendido y conversación sin pausar. Un aviso separado confirma que OpenCode aceptó la petición y muestra que está esperando respuesta. El aviso se retira cuando empieza el texto del modelo.

Cierre corregido: un resultado final estable puede salir de la espera sin `onspeechend`. Los saludos breves completos, incluidos «Hola» y «Hola cómo vas», también pueden cerrar como provisional estable; una frase larga que sigue provisional no se corta por un hueco entre resultados. Las continuaciones conservan espacios entre fragmentos finales. El envío manual retira el reconocedor anterior para que sus callbacks tardíos no dupliquen el mensaje. Solo transcripción fuerza la ruta del navegador incluso si hay STT remoto configurado.

Las pruebas del controlador con temporizadores reales y eventos simulados verifican unos 900 ms de estabilidad más 250 ms de ensamblado para esos saludos (aproximadamente 1,1 s), y envío manual inmediato sin duplicación por final tardío. Son tiempos del cierre y entrega al callback; no incluyen el envío HTTP ni la respuesta del modelo. El navegador de herramientas bloqueó abrir la página local de prueba por su política de URL; se verificó el controlador en Node sin red ni micrófono en vez de buscar un rodeo a ese bloqueo. No se ha probado todavía el reconocimiento real del navegador del usuario después del cambio.
