# Orquestador opcional

## Uso

Este instalador configura únicamente el workspace aislado de compatibilidad;
no instala agentes en las carpetas elegidas por el cliente nativo ni en Codex.
Ejecuta `pnpm run harness:install` y reinicia `pnpm start:legacy`. El resultado muestra
`installed`, `enabled` y el commit usado. Prueba pidiendo un trabajo acotado:
«Delega en arquitecto-skills revisar la coherencia de mis contratos; no cambies
archivos, solo informa hallazgos». Autoriza únicamente los permisos pertinentes.
La elección de herramientas y respuesta sigue dependiendo del modelo; instalar
no prueba que todos los proveedores permitan delegar o adjuntar audio.

Fuente fija: Cassers/Mi-agente-agent-system,
`c2d2722e681477df9b6e80ab988c14049486a4b7`.
El instalador copia SYSTEM/, Agentes/ y ME/SKILLS/, no la identidad, memoria,
bootstrap ni reglas de raíz del upstream. SYSTEM/README.md y ME/SKILLS/INDEX.md
locales se conservan: las versiones importadas quedan en SYSTEM/HARNESS-README.md
y ME/SKILLS/HARNESS.md. Los scripts del corpus son referencias: no se ejecutan.

## Qué queda registrado

- Orquestador: el agente build estándar con SYSTEM/OPENCODE-HARNESS.md añadido a
  sus instrucciones; no se cambia su identidad ni se fuerza un modelo.
- Subagente: arquitecto-skills, con entrada SYSTEM/ARQUITECTO-OPENCODE.md y su
  contrato/skill en Agentes/arquitecto-skills/. No tiene acceso MCP de pantalla.
- Skills: orquestar-agentes, crear-prompts, crear-superskills, investigar-profundo
  y sus referencias en ME/SKILLS/. Se consultan por archivo bajo demanda, no se
  instalan globalmente ni se duplican automáticamente en catálogos de skills.

Para comprobar el registro: `pnpm run opencode -- agent list`. Si creas otro
agente, configura su carpeta/skills y luego su definición nativa en la
configuración local de OpenCode o .opencode/agents/. La fila de REGISTRY.md sola
no basta. Reinicia y verifica que el agente aparece antes de delegar.

## Seguridad y recuperación

No amplía permisos globales ni cambia proveedores o modelos. Hereda permisos
nativos; los del subagente se envían solo al chat padre verificado. Limita las
delegaciones a primer plano, sin subagentes en background ni profundidad extra.
Es aislamiento de archivos/configuración, no una sandbox del sistema operativo.

`--disable` retira solo la instrucción y el registro que instaló el comando,
sin borrar las carpetas importadas. Si cambiaste la definición nativa del agente,
se niega a descartarla: guarda tu configuración y retira manualmente su entrada
en opencode/xdg/opencode/opencode.json y SYSTEM/OPENCODE-HARNESS.md de `instructions`.
El recibo de instalación permanece privado en opencode/harness-state.json.

Si se interrumpió la instalación, los archivos ya copiados quedan inactivos hasta
activación; repetir el comando puede completarla si no hay conflictos. Un bloqueo
residual opencode/harness.lock solo debe retirarse tras verificar que no queda
otra instalación en curso. No hay `--force` ni borrado masivo de personalizaciones.

Documentación técnica contrastada: [agentes y herencia de modelo](https://opencode.ai/docs/agents/),
[permisos](https://opencode.ai/docs/permissions/) y
[configuración](https://opencode.ai/docs/config/). La compatibilidad se verifica
con OpenCode 1.19.3, fijado por el lockfile de la app.

## Contrato de implementación

- El comando explícito instala la revisión fija de Cassers/Mi-agente-agent-system;
  setup/start ordinarios no descargan ni activan esa capa.
- Se conservan CONFIG.json, identidad, usuario, memorias y credenciales locales.
- El protocolo, skills e IA_TEMPLATE quedan disponibles; arquitecto-skills se
  registra como subagente nativo, sin fijarle otro modelo ni ampliar permisos.
- El asistente principal sigue siendo build, con instrucciones adicionales;
  onboarding y saludos no disparan investigación/delegación obligatoria.
- Delegaciones en primer plano: permisos del hijo llegan al chat propietario,
  nunca a otro chat. No se reproduce el texto interno del hijo como respuesta.
- Repetir instalación no sobrescribe personalizaciones; conflictos fallan antes
  de activar. Desactivar conserva archivos/memorias y no restaura a ciegas un
  respaldo sobre cambios nuevos de configuración.

## Diseño y verificación

Descarga Git de commit fijo, lectura de blobs permitidos sin checkout ni ejecución
de scripts. Plan previo de archivos; activación mediante JSON atómico y recibo
privado bajo opencode/. Adaptador propio separa reglas de app del corpus upstream.
Pruebas de instalación/repetición/conflicto/desactivación, rutas/symlinks,
propiedad de sesiones hijas y aceptación de configuración por OpenCode 1.19.3.
No se requieren llamadas al modelo ni captura/audio real para validar instalación.

Rollback: desactivar el módulo, conservando los documentos. El transporte de
permisos hijos es una unidad independiente; retirar su import/dispatcher vuelve
al comportamiento anterior sin editar perfiles, conversaciones ni grabaciones.

## Recibo de verificación (2026-10-23)

- Descarga real de la revisión fija en una instalación temporal, sin ejecutar
  scripts del origen. Perfil local de la app no activado ni modificado.
- Servidor real OpenCode 1.19.3: GET /agent reconoce arquitecto-skills como
  subagent, sin modelo fijado, con task denegado; build sigue presente.
  Tras desactivar y reiniciar el servidor de prueba, el subagente desaparece
  y build conserva su regla global ask.
- Pruebas del bridge real contra servidor ficticio: el permiso de un hijo se
  muestra en el WebSocket padre, requiere confirmación y responde once; sesiones
  de otro directorio no llegan al diálogo. Texto/idle hijos no se reproducen.
- Regresión 107/107 pruebas y build de la app correctos; casos de conservación
  de perfil/memorias/modelo/permisos, repetición, conflictos, desactivación,
  fallos de red, rutas, symlinks y bloqueo de instalaciones concurrentes.
- Sin inferencia real: estos checks validan instalación/transporte, no garantizan
  la calidad del orquestador ni compatibilidad de cada modelo gratuito.
