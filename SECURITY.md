# Política de Seguridad

Este repositorio contiene un sistema de gestión de asistencia (Gestion_Horas / SisHoras)
que procesa datos de empleados y se integra con relojes biométricos y una fuente
externa de solo lectura (`att2000`). Tomamos en serio cualquier hallazgo que
pueda comprometer esos datos o la integridad de la integración.

## Versiones soportadas

El proyecto se desarrolla en un único tronco (`main`) desplegado de forma
continua; no se mantienen líneas de versión paralelas. Los parches de
seguridad se aplican sobre el HEAD de `main` y se despliegan según el
procedimiento operativo interno — no hay backports a commits anteriores.

| Rama / línea | Soportada |
| ------------ | --------- |
| `main` (HEAD)      | :white_check_mark: |
| Commits anteriores | :x: |

## Cómo reportar una vulnerabilidad

**No abras un issue público** para reportar una vulnerabilidad de seguridad:
un issue público expone el hallazgo (y potencialmente una ruta de explotación)
antes de que exista un parche.

En su lugar:

1. Usá **GitHub Security Advisories** en este repositorio
   (pestaña *Security* → *Report a vulnerability*) para abrir un reporte
   privado. Es el canal preferido: mantiene el hallazgo confidencial entre
   quien reporta y quienes administran el repositorio hasta que haya una
   corrección.
2. Si no tenés acceso a Security Advisories, contactá directamente a quien
   mantiene el repositorio a través de un canal privado ya existente
   (no publiques el detalle técnico en un canal abierto).
3. Incluí en el reporte: una descripción del problema, los pasos para
   reproducirlo, el impacto estimado (qué datos o funcionalidad se ven
   afectados) y, si es posible, una prueba de concepto. **No incluyas**
   credenciales reales, IPs internas, datos de empleados ni marcaciones/PII
   en el reporte — usá datos de prueba o placeholders.

### Qué esperar

- **Confirmación de recepción:** dentro de 3 días hábiles.
- **Evaluación inicial** (severidad, alcance, si aplica): dentro de 7 días
  hábiles de la confirmación.
- **Actualizaciones de estado:** al menos cada 14 días mientras el reporte
  siga abierto, hasta su resolución o cierre.
- **Resolución:** el tiempo depende de la severidad y la complejidad del
  fix. Los hallazgos que afecten la propiedad **read-only** de `att2000`,
  la exposición de credenciales/PII, o la autenticación/autorización se
  tratan con prioridad alta.
- Si el reporte es **aceptado**, se coordina un parche y, cuando corresponda,
  se publica un aviso (GitHub Security Advisory) una vez que la corrección
  esté disponible. Se puede acordar con quien reportó una divulgación
  coordinada (fecha de publicación) antes de hacerla pública.
- Si el reporte es **rechazado** (no reproducible, fuera de alcance, o
  comportamiento esperado), se explica el motivo por el mismo canal privado.

## Alcance

Dentro de alcance: el código de este repositorio (`api/`, `web/`, `bridge/`,
`analytics/`, migraciones de base de datos, workflows de CI) y su
configuración tal como está versionada.

Fuera de alcance: la infraestructura de despliegue real (servidores, dominios,
credenciales, relojes biométricos físicos y la instancia real de `att2000`),
que no se documenta ni se referencia con datos reales en este repositorio.
Un reporte sobre infraestructura real debe hacerse por el canal privado
directo, nunca citando hosts, IPs o credenciales reales en un issue, PR o
comentario público de este repositorio.

## Reglas no negociables que cualquier corrección debe respetar

- `att2000` es una fuente **estrictamente de solo lectura**: ninguna
  corrección de seguridad debe agregar escritura hacia esa base.
- No se fabrican ni recalculan datos de asistencia (marcaciones, horas
  trabajadas, ausencias) como parte de un fix; ver `CLAUDE.md` y
  `docs/AI_HANDOFF.md`.
- Ningún parche debe introducir credenciales, hosts internos, IPs privadas
  ni PII de empleados en el código, los tests, la documentación o los logs.
