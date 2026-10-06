# Lectura manual de relojes desde Sincronización

La pantalla de Sincronización esperaba la respuesta completa de
`POST /api/devices/backup-all`, con un timeout de dos minutos. La cola persistente
`sync_jobs` y el worker ya existían, pero esta pantalla no los utilizaba. Además,
el mensaje agregado podía mostrar éxito aunque un reloj tuviera una lectura
incompleta, y al terminar no se actualizaban los indicadores del día ni las
marcaciones pendientes de vinculación.

## Comportamiento

- «Leer relojes del rango» envía una sola solicitud a
  `POST /api/devices/sync-jobs`, con las fechas elegidas y los dos intentos que
  usaba el flujo anterior. La aceptación del trabajo no se presenta como una
  lectura completada.
- La pantalla consulta `GET /api/devices/sync-jobs/:id` cada tres segundos,
  sin superponer consultas. Muestra el estado, el progreso y el resultado de
  cada reloj por separado: en cola, en lectura, finalizado, parcial, error o
  cancelado.
- Los contadores muestran las marcas leídas, en rango, importadas, duplicadas
  y sin empleado. Un contador ausente se muestra como «—», nunca como cero.
  «Lectura finalizada» describe la conclusión del trabajo; no certifica la
  cobertura del período ni la presencia de empleados.
- Una lectura parcial avisa que se debe revisar su cobertura antes de usarla
  para calcular horas. El fallo de un reloj no oculta los resultados de otros.
- Una consulta de estado fallida conserva el último estado conocido y se
  reintenta mediante GET. No vuelve a encolar ni declara fallida la lectura
  del reloj por una interrupción de la conexión del navegador.
- «Cancelar lectura» solicita cancelación al endpoint existente. La pantalla
  espera la confirmación del estado `cancelled`; aceptar la solicitud no
  equivale a que el trabajo ya esté detenido.
- Al finalizar todos los trabajos se actualizan diagnóstico, estado de relojes,
  indicadores del día y marcaciones sin empleado. Al salir de la pantalla
  se detienen sus consultas; los trabajos del servidor continúan. La sección
  Relojes permite revisar el estado de los equipos.
- Las fechas deben ser reales y ordenadas. Mientras el lote esté activo se
  impide otro envío desde este formulario. Si no se pudo confirmar el alta,
  no hay reintento automático: se indica revisar los trabajos antes de repetir.

## Alcance y verificación

El cambio es de interfaz. Reutiliza los endpoints y el worker actuales; no
modifica permisos, protocolo TCP/UDP, recálculo, esquema, configuración automática,
gates ni excepciones de seguridad. Requiere que el worker esté operativo; un
trabajo en cola puede permanecer pendiente si el servicio no procesa trabajos.

Las siete reproducciones de componente fallan sobre `40e86e0`, antes del cambio.
La suite final cubre esas reproducciones y tres controles adicionales: contadores
ausentes, identidad de la respuesta del trabajo y pérdida de respuesta del alta.
Usa la página real con HTTP simulado; no lee relojes físicos ni producción.

## Siguiente verificación operativa

Después de revisión y despliegue autorizado, un piloto acotado debe confirmar
que el worker procesa el lote, que cada reloj devuelve marcaciones del período
solicitado y que repetir una lectura no duplica asistencia. La lectura parcial
o truncada de Comedor requiere su propio diagnóstico; este cambio no repara
el buffer del equipo.

Luego corresponde revisar los vínculos de usuarios biométricos con empleados,
reprocesar sólo los casos verificados y contrastar las horas calculadas con
marcaciones, horarios y reglas vigentes. La activación automática y el piloto
en producción son decisiones posteriores; este PR no los ejecuta. att2000
permanece sin cambios.
