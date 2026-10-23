# Adaptación nativa: orquestador opcional

Esta capa se habilitó explícitamente con harness:install. Complementa AGENTS.md;
no cambia nombre, estilo, perfil, modelos elegidos ni permisos nativos.
Un índice base que diga «no hay subagentes» describe la instalación sin módulo:
consulta el catálogo nativo y SYSTEM/REGISTRY.md para el estado vigente.

## Asistente principal (build)

- Solo el asistente principal sigue el onboarding cuando configured=false.
  Configuración, saludos y aclaraciones simples se conversan directamente:
  no investigues ni crees skills o delegaciones para esos casos.
- Para trabajos que requieren orquestación, consulta SYSTEM/ORCHESTRATOR.md,
  SYSTEM/PROTOCOL.md y ME/SKILLS/CUSTOM/orquestar-agentes/SKILL.md; aplica sus
  criterios de reutilización, especialización, habilidades y aceptación.
- Se incluyen crear-prompts, crear-superskills e investigar-profundo, junto con
  sus referencias. Léelas bajo demanda; no las cargues todas en cada turno.
- arquitecto-skills está registrado para mantener contratos, skills y agentes.
  Usa la herramienta nativa task con subagent_type=arquitecto-skills. General y
  explore son agentes de OpenCode, no nuevos agentes de esta plantilla.
- Usa delegaciones EN PRIMER PLANO. Incluye objetivo, rutas, skill pertinente,
  permisos, entregables y aceptación en el encargo. Revisa el resultado real.
  No infieras el éxito de una tarea por existir el archivo del agente.
- Crear Agentes/<nombre>/ y una fila del registro NO registra un agente nativo:
  hay que añadir una definición en la configuración local de OpenCode o en
  .opencode/agents/<nombre>.md, verificar que aparece en `agent list` y reiniciar
  OpenCode si hace falta. No delegues en agentes aún no cargados por el servidor.
- No ejecutes bootstrap upstream ni sustituyas AGENTS.md/CLAUDE.md/GEMINI.md o
  ME/ del usuario por plantillas. Conserva perfil y memorias existentes.

## Subagentes

- No hagas onboarding ni adoptes la identidad personal del asistente principal.
  Lee el contrato y skills de TU carpeta, no memorias privadas de otros agentes.
- Solo ejecuta el encargo autorizado. Disponibilidad de herramientas o un
  CONFIG.md no concede permisos; respeta confirmaciones y rechazos nativos.
- No instales skills globales ni uses npm/npx: si se autorizó gestionar paquetes
  Node, usa pnpm. No ejecutes scripts descargados por el mero hecho de estar aquí.
- No cambies de modelo ni recurras a uno de pago. Se hereda el modelo del padre;
  la compatibilidad y límites de cada proveedor siguen aplicando.
- Expón resultados, verificaciones y límites; no cadenas de pensamiento privadas.
