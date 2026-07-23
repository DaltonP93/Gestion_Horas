/**
 * helpContent.ts
 * Contenido de ayuda por módulo. Clave = pathname de Next.js (sin trailing slash).
 * Cada entrada tiene: title, intro, sections[].
 */

export interface HelpSection {
  heading: string
  items: string[]
}

export interface HelpContent {
  title: string
  intro: string
  sections: HelpSection[]
}

const help: Record<string, HelpContent> = {

  '/dashboard': {
    title: 'Panel Principal',
    intro: 'Vista en tiempo real del estado de asistencia de todos los empleados del día.',
    sections: [
      {
        heading: 'KPIs (tarjetas superiores)',
        items: [
          'Empleados: total de empleados activos en el sistema.',
          'Presentes: quienes registraron entrada hoy (incluye retardos).',
          'Retardos: empleados que llegaron después de su horario + tolerancia.',
          'Ausentes: empleados activos sin ningún marcaje hoy.',
        ],
      },
      {
        heading: 'Marcadas en vivo',
        items: [
          'Se actualiza automáticamente via WebSocket cada vez que llega un nuevo marcaje.',
          'El ícono 🖐️ indica marcaje desde reloj biométrico, 📱 desde app móvil, ✏️ manual.',
          'Los KPIs pueden demorarse hasta el próximo ciclo del cron. Usá "Actualizar KPIs" para forzar el recalculo.',
        ],
      },
      {
        heading: 'Gráfico de torta',
        items: [
          'Muestra la distribución de estados del día: Presente, Retardo, Ausente, Permiso.',
          'Se actualiza junto con los KPIs.',
        ],
      },
    ],
  },

  '/asistencia': {
    title: 'Asistencia Diaria',
    intro: 'Tabla con el estado de cada empleado para la fecha seleccionada. Combina datos del daily_summary con marcajes en vivo.',
    sections: [
      {
        heading: 'Filtros disponibles',
        items: [
          'Fecha: filtra el resumen del día. Por defecto es hoy (hora Paraguay).',
          'Departamento: muestra solo el equipo de ese área.',
          'Búsqueda por nombre: filtra en tiempo real dentro de la tabla cargada.',
        ],
      },
      {
        heading: 'Estados de asistencia',
        items: [
          'Presente: entrada registrada dentro del horario + tolerancia.',
          'Retardo: entrada después del horario + tolerancia.',
          'Ausente: sin marcajes en el día.',
          'Permiso: ausencia justificada con permiso aprobado.',
          'Feriado / Fin de semana: días no laborables (no cuenta como ausencia).',
        ],
      },
      {
        heading: 'Acciones',
        items: [
          'Registrar marcaje manual: Admin/RH puede agregar entrada o salida con hora específica.',
          'Exportar CSV: descarga la tabla con los datos del día filtrado.',
          'Clic en empleado: lleva al perfil detallado con historial completo.',
        ],
      },
    ],
  },

  '/empleados': {
    title: 'Empleados',
    intro: 'Listado completo de empleados activos con filtros por departamento, sede y estado.',
    sections: [
      {
        heading: 'Crear empleado',
        items: [
          'El Código ZKTeco debe coincidir exactamente con el USERID configurado en el reloj.',
          'El número de empleado es el legajo interno (opcional).',
          'La Cédula de Identidad se usa para la exportación de nómina SAA.',
          'El turno define el horario esperado y calcula retardos automáticamente.',
        ],
      },
      {
        heading: 'Campos importantes',
        items: [
          'Estado activo/inactivo: solo empleados activos generan estadísticas de asistencia.',
          'Departamento: agrupa en reportes y define quién aprueba sus permisos.',
          'Sede: permite filtrar reportes y nómina por sucursal.',
        ],
      },
      {
        heading: 'Foto de perfil',
        items: [
          'Se puede subir desde el perfil del empleado (/empleados/[id]).',
          'Usada en el dashboard y reportes visuales.',
        ],
      },
    ],
  },

  '/permisos': {
    title: 'Permisos',
    intro: 'Gestión centralizada de solicitudes de permiso: licencias, ausencias, trabajo remoto, vacaciones cortas y otros.',
    sections: [
      {
        heading: 'Flujo de aprobación',
        items: [
          'El empleado solicita → coordinador aprueba (nivel 1) → gerente/RH aprueba (nivel 2).',
          'Los niveles de aprobación dependen de las reglas configuradas en Configuración → Reglas de Permisos.',
          'Cada aprobación o rechazo genera un email automático al empleado.',
        ],
      },
      {
        heading: 'Estados del permiso',
        items: [
          'Pendiente: esperando primera aprobación.',
          'Aprobado por coordinador: en espera del gerente/RH.',
          'Aprobado: permiso vigente, el daily_summary marca el día como "permiso".',
          'Rechazado: con nota explicativa al empleado.',
          'Cancelado: anulado por el propio solicitante.',
        ],
      },
      {
        heading: 'Adjuntos',
        items: [
          'Se puede subir un archivo (certificado médico, documento) al solicitar.',
          'Los aprobadores pueden ver el adjunto antes de decidir.',
        ],
      },
      {
        heading: 'Rechazo con fecha alternativa (vacaciones)',
        items: [
          'En una solicitud de vacaciones pendiente, el botón "Alternativa" permite rechazarla proponiendo otro rango de fechas.',
          'Se guarda el motivo y la fecha sugerida, para que el empleado pueda reprogramar.',
        ],
      },
    ],
  },

  '/aprobaciones': {
    title: 'Aprobaciones',
    intro: 'Bandeja unificada para gerentes y coordinadores: todos los permisos pendientes de tu equipo en un solo lugar.',
    sections: [
      {
        heading: 'Cómo aprobar',
        items: [
          'Revisá el motivo, fechas y adjunto del empleado.',
          'Hacé clic en Aprobar o Rechazar.',
          'Al rechazar, podés agregar un comentario que recibirá el empleado por email.',
          'Los permisos aprobados actualizan el daily_summary automáticamente.',
        ],
      },
      {
        heading: 'SLA de aprobaciones',
        items: [
          'El sistema alerta si un permiso lleva más de X horas sin respuesta (configurable).',
          'Ver widget de SLA en el detalle del empleado.',
        ],
      },
    ],
  },

  '/reportes': {
    title: 'Reportes',
    intro: 'Genera y descarga reportes de asistencia en múltiples formatos. También podés programar envíos automáticos por email.',
    sections: [
      {
        heading: 'Reporte de Marcadas',
        items: [
          'Muestra todas las entradas y salidas pareadas por día y empleado.',
          'Descarga en PDF (formato imprimible, firma + sello) o CSV.',
          'Podés filtrar por empleado, departamento y rango de fechas.',
          'Las marcas antes de las 5:00 am se asignan al turno del día anterior.',
        ],
      },
      {
        heading: 'Planilla Mensual',
        items: [
          'Una fila por día por empleado: estado, hora entrada/salida, minutos trabajados, atrasos, horas extra.',
          'Export Excel (.xlsx) con una hoja por empleado + hoja resumen.',
          'El PDF incluye firma y sello digital configurados en Configuración → Firma.',
        ],
      },
      {
        heading: 'Reportes programados',
        items: [
          'Configurá un cron (ej: "0 7 * * 1" = lunes a las 7am) para envío automático.',
          'El reporte llega por email a los destinatarios configurados.',
          'Requiere SMTP configurado en el servidor (.env SMTP_HOST, SMTP_USER, etc.).',
        ],
      },
    ],
  },

  '/reportes/personalizado': {
    title: 'Reportes Personalizados',
    intro: 'Constructor visual de reportes: seleccioná columnas, filtros, formato y destinatarios.',
    sections: [
      {
        heading: 'Cómo crear un reporte',
        items: [
          'Elegí el tipo base: asistencia diaria, resumen mensual, permisos, nómina.',
          'Seleccioná las columnas a incluir.',
          'Aplicá filtros opcionales: departamento, sede, empleado, fecha.',
          'Guardá como plantilla para reutilizar.',
        ],
      },
    ],
  },

  '/usuarios': {
    title: 'Usuarios del Sistema',
    intro: 'Gestión de cuentas de acceso al sistema. Cada usuario tiene un rol que determina qué puede ver y hacer.',
    sections: [
      {
        heading: 'Roles disponibles',
        items: [
          'Super Admin: acceso total, puede gestionar todo incluyendo configuración crítica.',
          'Admin: acceso completo excepto configuración de sistema.',
          'RH / GTH: gestión de empleados, permisos y reportes.',
          'Supervisor: solo ve su equipo (empleados de sus departamentos).',
          'Empleado: solo ve su propio perfil, asistencia y permisos.',
        ],
      },
      {
        heading: 'Vincular usuario a empleado',
        items: [
          'Podés asociar un usuario a un registro de empleado para que vea su asistencia personal.',
          'Sin vinculación, el usuario no tiene acceso a /mi-asistencia ni /marcar.',
        ],
      },
      {
        heading: 'Permisos granulares',
        items: [
          'Desde /usuarios/[id]/permisos podés habilitar/deshabilitar acceso a módulos específicos.',
          'Ejemplo: dar acceso a "nomina" solo a contabilidad.',
        ],
      },
    ],
  },

  '/analytics': {
    title: 'Analytics por Empleado',
    intro: 'Gráficas avanzadas de comportamiento de asistencia para un empleado específico en los últimos meses.',
    sections: [
      {
        heading: 'Gráficas disponibles',
        items: [
          'Tendencia semanal: horas trabajadas por semana en el período.',
          'Por día de la semana: días con mayor presencia.',
          'Tasa de asistencia: % días presentes vs total de días hábiles.',
          'Promedio de hora de entrada: llegada promedio en el período.',
        ],
      },
      {
        heading: 'Período de análisis',
        items: [
          'Podés seleccionar 1, 3 o 6 meses hacia atrás.',
          'Los datos se calculan en tiempo real desde daily_summary.',
        ],
      },
    ],
  },

  '/vacaciones': {
    title: 'Vacaciones',
    intro: 'Plan de vacaciones, saldos por empleado y política parametrizable por antigüedad. Se organiza en tres pestañas: Plan mensual, Saldos y Política.',
    sections: [
      {
        heading: 'Plan mensual',
        items: [
          'Vista tipo Gantt de permisos y vacaciones aprobados/pendientes por empleado.',
          'Detecta posibles conflictos de cobertura (3 o más personas ausentes el mismo día se marcan con ⚠).',
          'Botón "Solicitar ausencia" para cargar un pedido propio o (RRHH) de un empleado.',
        ],
      },
      {
        heading: 'Saldos (por empleado y año)',
        items: [
          'Muestra antigüedad, derecho (según la política), días asignados, ajuste, tomados y disponible.',
          'Los días tomados se cuentan en días hábiles (excluye fines de semana y feriados) salvo que la política use días corridos.',
          'RRHH puede sobrescribir el derecho con "Asignar" (días asignados) y aplicar un ajuste manual (+/−) con nota.',
        ],
      },
      {
        heading: 'Política (parametrizable)',
        items: [
          'Tramos por antigüedad → días (ej. Paraguay: <5 años 12, 5–10 18, >10 30). Editable: agregá/quitá tramos.',
          'Tipo de conteo: días hábiles (excluye finde/feriados) o días corridos.',
          'Solo Admin/GTH/RRHH pueden editar la política y los saldos.',
        ],
      },
      {
        heading: 'Rechazo con fecha alternativa',
        items: [
          'Las solicitudes de vacaciones se aprueban/rechazan en el módulo Permisos.',
          'Al rechazar se puede proponer un rango de fechas alternativo para que el empleado reprograme.',
        ],
      },
    ],
  },

  '/banco-horas': {
    title: 'Banco de Horas',
    intro: 'Registro y control de horas extra acumuladas que pueden compensarse con descanso posterior.',
    sections: [
      {
        heading: 'Cómo funciona',
        items: [
          'Las horas extra se calculan cuando el empleado trabaja más allá de su horario de salida.',
          'El banco acumula los minutos extra. Se puede autorizar tiempo libre compensatorio.',
          'Los movimientos (crédito/débito) quedan registrados con motivo y aprobador.',
        ],
      },
      {
        heading: 'Reglas',
        items: [
          'Solo se acumulan si la empresa tiene habilitado el banco de horas.',
          'La expiración (opcional) se configura por política de la empresa.',
        ],
      },
    ],
  },

  '/calendario': {
    title: 'Calendario',
    intro: 'Vista mensual de permisos, vacaciones y feriados de todo el equipo en un mismo lugar.',
    sections: [
      {
        heading: 'Qué muestra',
        items: [
          'Eventos de tipo permiso, vacaciones y feriados del mes visible.',
          'Color por tipo: azul = permiso, verde = vacaciones, naranja = feriado.',
          'Clic en un evento para ver el detalle del empleado y estado.',
        ],
      },
    ],
  },

  '/comunicados': {
    title: 'Comunicados',
    intro: 'Tablón de anuncios internos para toda la organización o grupos específicos.',
    sections: [
      {
        heading: 'Crear comunicado',
        items: [
          'Solo Admin/RH pueden publicar.',
          'Podés dirigirlo a todos, a un departamento o a una sede.',
          'Los destinatarios reciben notificación en el panel de alertas.',
        ],
      },
    ],
  },

  '/capacitaciones': {
    title: 'Capacitaciones',
    intro: 'Gestión de cursos y asignaciones de formación al personal.',
    sections: [
      {
        heading: 'Flujo',
        items: [
          'Admin crea el curso (nombre, descripción, duración, fecha límite).',
          'Asigna el curso a empleados o departamentos.',
          'El sistema envía recordatorio por email 3 días antes del vencimiento.',
          'El empleado marca el curso como completado desde su perfil.',
        ],
      },
    ],
  },

  '/encuestas': {
    title: 'Encuestas de Pulso',
    intro: 'Encuestas cortas y anónimas para medir el clima laboral del equipo.',
    sections: [
      {
        heading: 'Crear encuesta',
        items: [
          'Definí preguntas con escala (1-5), selección múltiple o texto libre.',
          'Dirigí la encuesta a todo el personal o a un departamento.',
          'Los resultados son anónimos: no se puede identificar quién respondió qué.',
        ],
      },
      {
        heading: 'Ver resultados',
        items: [
          'Gráfico de barras para cada pregunta.',
          'Porcentaje de respuesta y promedio por pregunta.',
        ],
      },
    ],
  },

  '/evaluaciones': {
    title: 'Evaluaciones de Desempeño',
    intro: 'Sistema de evaluación periódica del rendimiento de los empleados.',
    sections: [
      {
        heading: 'Plantillas',
        items: [
          'Creá plantillas con criterios: puntualidad, productividad, trabajo en equipo, etc.',
          'Cada criterio tiene una escala configurable (ej: 1-5, 1-10).',
          'Una misma plantilla se puede usar para todas las evaluaciones del período.',
        ],
      },
      {
        heading: 'Proceso de evaluación',
        items: [
          'RH abre un ciclo de evaluación (ej: "Semestral 2025").',
          'El evaluador (supervisor/gerente) completa la ficha de cada empleado.',
          'El sistema calcula puntaje final y genera historial por empleado.',
        ],
      },
    ],
  },

  '/onboarding': {
    title: 'Checklists de ingreso',
    intro: 'Flujo de tareas estructurado para la incorporación o salida de empleados. Los datos de contrato y la baja formal se gestionan en el módulo Ingresos / Egresos.',
    sections: [
      {
        heading: 'Checklist de ingreso',
        items: [
          'Cuando contratan a alguien, se crea un proceso basado en una plantilla.',
          'Ejemplo de tareas: "Firmar contrato", "Entregar credenciales de acceso", "Tour de oficina", "Alta en sistema".',
          'Cada tarea tiene un responsable y una fecha límite.',
          'Avance visible en porcentaje. Email de alerta si hay tareas vencidas.',
        ],
      },
      {
        heading: 'Checklist de egreso',
        items: [
          'Al dar de baja a un empleado, se puede iniciar un proceso de salida.',
          'Ejemplo de tareas: "Devolver equipos", "Revocar accesos al sistema", "Entrevista de salida".',
          'El proceso queda registrado en el historial del empleado.',
        ],
      },
      {
        heading: 'Plantillas',
        items: [
          'Creá plantillas reutilizables en el botón "Nueva plantilla".',
          'Las tareas de la plantilla se copian a cada nuevo proceso.',
        ],
      },
      {
        heading: 'Relación con Ingresos / Egresos',
        items: [
          'El contrato, el período de prueba y la baja formal (fecha y motivo) se cargan en el módulo Ingresos / Egresos.',
          'Este módulo es solo la lista de tareas operativas del alta/baja.',
        ],
      },
    ],
  },

  '/nomina': {
    title: 'Nómina SAA',
    intro: 'Exportación mensual de datos de asistencia en el formato que usa el sistema contable SAA.',
    sections: [
      {
        heading: 'Qué contiene',
        items: [
          'Código, nombre, cédula, departamento, sede.',
          'Días trabajados, horas trabajadas, horas extra.',
          'Minutos de atraso acumulados, ausencias, permisos, vacaciones, licencias médicas.',
        ],
      },
      {
        heading: 'Cómo usarlo',
        items: [
          'Seleccioná año, mes y sede (opcional).',
          'Hacé clic en "Actualizar" para previsualizar los datos.',
          'Descargá en Excel (.xlsx) o CSV para importar en SAA.',
          'La cédula se toma del campo "Cédula de identidad" del empleado. Si está vacío, se usa el número de empleado.',
        ],
      },
    ],
  },

  '/departamentos': {
    title: 'Departamentos',
    intro: 'Estructura organizacional de la empresa: departamentos, coordinadores y gerentes.',
    sections: [
      {
        heading: 'Gestión',
        items: [
          'Cada departamento puede tener un coordinador y un gerente asignados.',
          'Los coordinadores y gerentes aparecen como aprobadores en el flujo de permisos.',
          'Asignar la sede permite filtrar reportes por sucursal.',
        ],
      },
    ],
  },

  '/configuracion': {
    title: 'Configuración General',
    intro: 'Parámetros globales del sistema: identidad de la empresa, idioma, zona horaria y accesos a la configuración de cada módulo.',
    sections: [
      {
        heading: 'Identidad de la empresa',
        items: [
          'Logo: se muestra en el sidebar y en los PDFs generados.',
          'Nombre de la empresa: aparece en los reportes y correos.',
          'Zona horaria: usada para calcular retardos y fechas de reportes (Paraguay = America/Asuncion, UTC−3).',
        ],
      },
      {
        heading: 'Dónde se configura cada módulo (todo parametrizable)',
        items: [
          'Turnos, Feriados, Sedes (+ geocerca), Apariencia, Firma, QR de asistencia, Webhooks, Plantillas de email, Reglas de permisos y Metas: en Configuración.',
          'Reglas (condiciones): constructor de reglas "cuando… entonces…" por módulo, en Administración → Reglas.',
          'Planillas legales (MTESS/IPS): parámetros de liquidación, salario mínimo, recargo nocturno y plus nocturno, en Reportes → Planillas legales.',
          'Vacaciones: política por antigüedad y saldos, dentro del módulo Vacaciones.',
          'Ingresos/Egresos: tipos de contrato y alertas de vencimiento; Maternidad/Lactancia: reducción y edad máxima, cada uno en su módulo.',
          'Hora extra (autorización) y umbrales de marcación fuera de rango: en sus respectivos módulos.',
        ],
      },
    ],
  },

  '/configuracion/turnos': {
    title: 'Turnos / Horarios',
    intro: 'Define los horarios de trabajo que se asignan a los empleados.',
    sections: [
      {
        heading: 'Campos del turno',
        items: [
          'Hora de entrada: se usa para calcular si el empleado llegó tarde.',
          'Tolerancia en minutos: margen aceptable antes de marcar retardo (ej: 10 min).',
          'Hora de salida: referencia para calcular horas extra.',
          'Horas semanales: referencia para reportes de productividad.',
        ],
      },
    ],
  },

  '/configuracion/feriados': {
    title: 'Feriados',
    intro: 'Lista de días no laborables (feriados nacionales y propios de la empresa).',
    sections: [
      {
        heading: 'Cómo funciona',
        items: [
          'Los días marcados como feriado no se cuentan como ausencia aunque no haya marcajes.',
          'El daily_summary muestra estado "feriado" automáticamente.',
          'Podés cargar todos los feriados del año de una vez.',
        ],
      },
    ],
  },

  '/configuracion/sedes': {
    title: 'Sedes / Sucursales',
    intro: 'Gestión de las ubicaciones físicas de la empresa para reportes multi-sede y para la geocerca de marcación móvil.',
    sections: [
      {
        heading: 'Usos',
        items: [
          'Filtrar reportes y nómina por sede.',
          'Asignar empleados y dispositivos a una sede.',
          'Cada sede puede tener su propio timezone.',
        ],
      },
      {
        heading: 'Geocerca por sede',
        items: [
          'En cada sede podés cargar latitud, longitud y radio (m); el botón "Usar mi ubicación" completa las coordenadas desde tu GPS.',
          'La marcación móvil valida que el empleado esté dentro del radio de su sede.',
          'Una sede sin coordenadas no valida perímetro (se usa el radio por defecto sólo si define coordenadas).',
        ],
      },
      {
        heading: 'Modo de geocerca (global)',
        items: [
          'Desactivado: no valida la ubicación.',
          'Advertir: permite marcar pero registra si fue fuera del área.',
          'Exigir: rechaza el marcaje fuera del radio.',
          'También se define el radio por defecto para sedes sin radio propio.',
        ],
      },
    ],
  },

  '/configuracion/apariencia': {
    title: 'Apariencia',
    intro: 'Personalización visual del sistema: logo, colores, favicon.',
    sections: [
      {
        heading: 'Opciones',
        items: [
          'Logo principal: aparece en sidebar y PDFs.',
          'Favicon: ícono en la pestaña del navegador.',
          'Color primario: personaliza el color de la interfaz.',
        ],
      },
    ],
  },

  '/configuracion/firma': {
    title: 'Firma Digital',
    intro: 'Configuración de la firma y sello que aparecen al pie de los PDFs generados.',
    sections: [
      {
        heading: 'Campos',
        items: [
          'Firma: imagen PNG/JPG de la firma del firmante autorizado.',
          'Sello: imagen del sello de la empresa.',
          'Nombre del firmante, cargo y número de documento.',
        ],
      },
    ],
  },

  '/configuracion/qr-asistencia': {
    title: 'QR de Asistencia',
    intro: 'Genera un código QR que los empleados escanean desde su celular para marcar entrada/salida.',
    sections: [
      {
        heading: 'Cómo funciona',
        items: [
          'Imprimí o mostrá el QR en la entrada de la empresa.',
          'El empleado lo escanea con su celular, abre la app y confirma el marcaje.',
          'Requiere que el empleado tenga usuario en el sistema.',
        ],
      },
    ],
  },

  '/configuracion/webhooks': {
    title: 'Webhooks',
    intro: 'Notificaciones automáticas a sistemas externos (Oracle APEX, ERP, Slack, Teams) cuando ocurren eventos.',
    sections: [
      {
        heading: 'Eventos disponibles',
        items: [
          'attendance.checkin / attendance.checkout: cuando un empleado marca.',
          'permission.approved / permission.rejected: cambio de estado de permisos.',
          'Podés agregar headers de autorización personalizados.',
        ],
      },
    ],
  },

  '/configuracion/integraciones-hr': {
    title: 'Integraciones HR Externas',
    intro: 'Sincronización de datos de empleados desde sistemas externos (RRHH, ERP, Active Directory).',
    sections: [
      {
        heading: 'Funcionamiento',
        items: [
          'Configura la URL y credenciales de la fuente externa.',
          'El sistema sincroniza periódicamente creando/actualizando empleados.',
          'El campo "code" (USERID del reloj) es la clave de reconciliación.',
        ],
      },
    ],
  },

  '/configuracion/plantillas-email': {
    title: 'Plantillas de Email',
    intro: 'Editor de los correos automáticos que envía el sistema (aprobación de permisos, alertas, reportes).',
    sections: [
      {
        heading: 'Personalización',
        items: [
          'Cada plantilla tiene variables dinámicas: {employee_name}, {date}, etc.',
          'Podés editar el asunto y el cuerpo HTML.',
          'Vista previa antes de guardar.',
        ],
      },
    ],
  },

  '/configuracion/reglas-permisos': {
    title: 'Reglas de Permisos',
    intro: 'Define qué niveles de aprobación requiere cada tipo de permiso.',
    sections: [
      {
        heading: 'Configuración',
        items: [
          'Por tipo de permiso (médico, personal, vacaciones, etc.) podés definir si requiere 1 o 2 niveles.',
          'Nivel 1: coordinador del departamento.',
          'Nivel 2: gerente del departamento o RH.',
          'También podés configurar días mínimos de anticipación requeridos.',
        ],
      },
    ],
  },

  '/configuracion/metas': {
    title: 'Metas de KPIs',
    intro: 'Define objetivos de asistencia para medir el desempeño del equipo.',
    sections: [
      {
        heading: 'Métricas configurables',
        items: [
          'Tasa de asistencia objetivo (ej: 95%).',
          'Máximo de retardos aceptados por mes.',
          'Alertas automáticas cuando se supera el umbral.',
        ],
      },
    ],
  },

  '/supervisor': {
    title: 'Mi Equipo (Supervisor)',
    intro: 'Vista del supervisor: estado de asistencia hoy de todos los empleados de tus departamentos.',
    sections: [
      {
        heading: 'Qué podés hacer',
        items: [
          'Ver en tiempo real quién llegó, quién llegó tarde y quién falta.',
          'Aprobar o rechazar los permisos pendientes de tu equipo.',
          'Los departamentos visibles son los que tenés asignados como coordinador o gerente.',
        ],
      },
    ],
  },

  '/ejecutivo': {
    title: 'Dashboard Ejecutivo',
    intro: 'Vista de alto nivel para gerencia: KPIs agregados, tendencias y alertas críticas.',
    sections: [
      {
        heading: 'Indicadores',
        items: [
          'Tasa de asistencia global y por departamento.',
          'Tendencia semanal de presencias y ausencias.',
          'Top 5 empleados con más retardos del mes.',
          'Resumen de permisos aprobados vs pendientes.',
        ],
      },
    ],
  },

  '/auditoria': {
    title: 'Auditoría',
    intro: 'Log inmutable de todas las acciones realizadas en el sistema: quién hizo qué y cuándo.',
    sections: [
      {
        heading: 'Registros auditados',
        items: [
          'Altas, modificaciones y bajas de empleados.',
          'Aprobaciones y rechazos de permisos.',
          'Cambios de configuración.',
          'Accesos al sistema y cambios de contraseña.',
        ],
      },
      {
        heading: 'Filtros',
        items: [
          'Por fecha, por usuario que realizó la acción, por tipo de evento.',
          'Los registros no se pueden modificar ni eliminar.',
        ],
      },
    ],
  },

  '/cuenta/perfil': {
    title: 'Mi perfil',
    intro: 'Editá tus datos personales autorizados.',
    sections: [
      {
        heading: 'Qué podés editar',
        items: [
          'Nombre, apellido, correo, teléfono, domicilio y foto de perfil.',
          'Tu rol, permisos, estado, sucursal y grupos de seguridad los gestiona RR.HH.',
        ],
      },
    ],
  },

  '/cuenta/preferencias': {
    title: 'Preferencias',
    intro: 'Idioma, zona horaria y apariencia de la aplicación.',
    sections: [
      {
        heading: 'Opciones',
        items: [
          'Idioma: español, inglés o portugués.',
          'Zona horaria: usada para mostrar fechas y horas.',
          'Apariencia: tema claro u oscuro.',
        ],
      },
    ],
  },

  '/cuenta/seguridad': {
    title: 'Seguridad de mi cuenta',
    intro: 'Contraseña, sesiones activas y verificación en dos pasos (2FA).',
    sections: [
      {
        heading: 'Contraseña y sesiones',
        items: [
          'Cambiar contraseña: requiere la contraseña actual y cumplir los requisitos.',
          'Podés cerrar tus otras sesiones al cambiar la contraseña o desde el panel de sesiones.',
          'Último acceso y dispositivos/IP recientes se muestran para tu control.',
        ],
      },
      {
        heading: 'Autenticación 2FA',
        items: [
          'Activá 2FA con una app autenticadora (Google Authenticator, Authy).',
          'Al iniciar sesión necesitarás el código del teléfono además de la contraseña.',
          'Recomendado para cuentas Admin y RH.',
        ],
      },
    ],
  },

  '/mi-perfil': {
    title: 'Mi Perfil',
    intro: 'Tu cuenta de usuario: datos personales, cambio de contraseña y preferencias.',
    sections: [
      {
        heading: 'Opciones disponibles',
        items: [
          'Cambiar contraseña: requiere la contraseña actual por seguridad.',
          'Foto de perfil: se muestra en el sistema.',
          'Idioma: español / inglés.',
          'Notificaciones: configurar qué alertas recibís por email.',
        ],
      },
    ],
  },

  '/mi-asistencia': {
    title: 'Mi Asistencia',
    intro: 'Tu historial personal de asistencia: entradas, salidas y resumen mensual.',
    sections: [
      {
        heading: 'Qué podés ver',
        items: [
          'Detalle día por día: hora de entrada, hora de salida, minutos trabajados.',
          'Estado de cada día: presente, retardo, ausente, permiso.',
          'Resumen mensual: total de horas trabajadas, días de retardo.',
        ],
      },
    ],
  },

  '/mis-permisos': {
    title: 'Mis Permisos',
    intro: 'Solicitá y seguí el estado de tus permisos y licencias.',
    sections: [
      {
        heading: 'Solicitar permiso',
        items: [
          'Indicá el tipo: médico, personal, vacaciones, estudio, duelo, u otro.',
          'Fechas de inicio y fin, motivo y adjunto opcional (ej: certificado médico).',
          'La solicitud llega a tu coordinador para aprobación.',
        ],
      },
      {
        heading: 'Seguimiento',
        items: [
          'Podés ver el estado actual de cada solicitud.',
          'Recibirás un email cuando se apruebe, rechace o cancele.',
        ],
      },
    ],
  },

  '/marcar': {
    title: 'Marcar Asistencia',
    intro: 'Marcaje de entrada o salida desde tu dispositivo móvil con validación de ubicación (geocerca), QR o selfie.',
    sections: [
      {
        heading: 'Cómo marcar',
        items: [
          'El sistema detecta automáticamente si es entrada o salida según tus marcajes del día.',
          'Con GPS activo, valida que estés dentro del área de tu sede antes de registrar.',
          'También podés escanear el código QR de la sede para marcar.',
          'Si no hay conexión, el marcaje se guarda y se envía automáticamente al volver online.',
        ],
      },
      {
        heading: 'Geocerca (dentro/fuera)',
        items: [
          'La pantalla muestra en vivo si estás "Dentro" o "Fuera" del área permitida, con la distancia al centro de la sede.',
          'En modo "Exigir", estando fuera del radio no vas a poder marcar.',
          'En modo "Advertir", podés marcar pero queda registrado como fuera de rango para RRHH.',
          'Si tu sede no tiene coordenadas cargadas, no se valida perímetro.',
        ],
      },
    ],
  },

  '/sistema': {
    title: 'Sistema',
    intro: 'Panel de administración técnica: estado de servicios, integraciones y configuración avanzada.',
    sections: [
      {
        heading: 'Sub-módulos',
        items: [
          'Salud: estado en tiempo real de la API, base de datos, Redis y el bridge ZKTeco.',
          'Backups: historial y descarga de respaldos automáticos de la base de datos.',
          'GDPR: anonimización de datos de empleados inactivos por políticas de privacidad.',
          'Procesar: recalcular manualmente el daily_summary para fechas anteriores.',
          'Embed: tokens de acceso para integrar widgets del sistema en otras plataformas.',
        ],
      },
    ],
  },

  '/sistema/salud': {
    title: 'Estado del Sistema',
    intro: 'Monitor en tiempo real de los servicios críticos.',
    sections: [
      {
        heading: 'Qué monitorea',
        items: [
          'API Node.js: respuesta y latencia.',
          'MySQL: conexión y tiempo de consulta.',
          'Redis: conexión para Socket.io y caché.',
          'Bridge ZKTeco: estado del servicio de conexión con los relojes.',
          'SMTP: si el servidor de correo está configurado y responde.',
        ],
      },
    ],
  },

  '/sistema/backups': {
    title: 'Backups',
    intro: 'Respaldo automático de la base de datos MySQL.',
    sections: [
      {
        heading: 'Funcionamiento',
        items: [
          'Los backups se ejecutan según el cron configurado (por defecto: diario a las 2am).',
          'Se guardan en el servidor local y opcionalmente en S3/GCS.',
          'Podés descargar cualquier backup desde esta pantalla.',
          'El botón "Ejecutar ahora" fuerza un backup inmediato.',
        ],
      },
    ],
  },

  '/sistema/gdpr': {
    title: 'GDPR / Privacidad',
    intro: 'Herramientas para cumplir con la normativa de protección de datos personales.',
    sections: [
      {
        heading: 'Anonimización',
        items: [
          'Anonimiza datos de empleados inactivos que llevan más de X días fuera del sistema.',
          'Reemplaza nombres, emails y CI con valores genéricos.',
          'Los logs de asistencia quedan intactos pero desvinculados del nombre real.',
        ],
      },
    ],
  },

  '/turnera': {
    title: 'Turnera (turnos)',
    intro: 'Planificación de turnos y asignación de horarios a empleados por día, semana o mes.',
    sections: [
      {
        heading: 'Cómo funciona',
        items: [
          'Asigná a cada empleado el turno/horario que le corresponde en cada fecha.',
          'La semana va de domingo a sábado (convención Domingo=1 … Sábado=7).',
          'Los turnos definen entrada, salida, tolerancias y minutos de descanso, que alimentan el cálculo de retardos y horas extra.',
        ],
      },
      {
        heading: 'Relación con asistencia',
        items: [
          'El horario asignado determina si un marcaje es retardo y desde cuándo cuenta la hora extra.',
          'Los días no laborables del horario no generan ausencia.',
        ],
      },
    ],
  },

  '/horas-extra': {
    title: 'Horas Extra',
    intro: 'Revisión y autorización de las horas extra calculadas por el sistema, cuando la empresa exige aprobación.',
    sections: [
      {
        heading: 'Cómo funciona',
        items: [
          'La hora extra siempre se calcula (minutos que la salida excede el horario + tolerancia).',
          'Con "requiere autorización" activo, sólo las horas extra aprobadas se pagan/informan en las planillas.',
          'Cada día con hora extra puede aprobarse o rechazarse con una nota.',
        ],
      },
      {
        heading: 'Configuración',
        items: [
          'El interruptor "las horas extra requieren aprobación" se define en este módulo (solo Admin/GTH).',
          'Los multiplicadores (diurna 50%, nocturna 100%) y el recargo/plus nocturno se configuran en Planillas legales.',
        ],
      },
    ],
  },

  '/marcaciones-fuera-rango': {
    title: 'Marcaciones fuera de rango',
    intro: 'Detecta entradas muy anticipadas o salidas muy tardías respecto al horario, para que RRHH las revise.',
    sections: [
      {
        heading: 'Cómo funciona',
        items: [
          'Lista los días en que la entrada fue mucho antes o la salida mucho después del horario del empleado.',
          'Se usa para decidir si se autoriza la hora extra correspondiente, en vez de computarla automáticamente.',
        ],
      },
      {
        heading: 'Umbrales configurables',
        items: [
          'Entrada temprana (min) y salida tardía (min): definís cuántos minutos de desvío disparan la alerta.',
          'Sólo Admin/GTH pueden editar los umbrales.',
        ],
      },
    ],
  },

  '/marcaciones-geocerca': {
    title: 'Marcaciones fuera de geocerca',
    intro: 'Lista los marcajes móviles que quedaron registrados fuera del perímetro de la sede, para revisión de RRHH.',
    sections: [
      {
        heading: 'Cuándo aparecen',
        items: [
          'Cuando la geocerca está en modo "Advertir", el empleado puede marcar aunque esté fuera del radio, pero el marcaje se registra como "fuera".',
          'En modo "Exigir" el marcaje se rechaza, así que no aparece aquí.',
          'El modo y el radio se configuran en Configuración → Sedes.',
        ],
      },
      {
        heading: 'Qué muestra',
        items: [
          'Fecha/hora, empleado, tipo (entrada/salida), origen (app/QR/GPS), distancia al centro de la sede y enlace al mapa.',
          'Filtrable por período y departamento.',
        ],
      },
    ],
  },

  '/reportes/planillas-legales': {
    title: 'Planillas legales (MTESS / IPS)',
    intro: 'Genera las planillas legales de Paraguay y centraliza los parámetros de liquidación.',
    sections: [
      {
        heading: 'Planillas disponibles',
        items: [
          'Control de asistencia MTESS (PDF): grilla de entradas/salidas por empleado.',
          'Jornales IPS (Excel): días y horas por empleado con C.I. y N° IPS.',
          'Planilla de comunicación MTESS (Excel): formato de carga oficial con días trabajados por tipo de pago.',
          'Aportes IPS con montos y Aguinaldo (1/12 de lo percibido en el año).',
        ],
      },
      {
        heading: 'Días trabajados (regla MTESS)',
        items: [
          'Jornaleros: cantidad exacta de días trabajados.',
          'Mensualizados: base 30 menos reposo, ausencia injustificada, licencia especial, días sin goce y vacaciones. Los francos/feriados y permisos con goce no descuentan.',
        ],
      },
      {
        heading: 'Parámetros de liquidación (configurables)',
        items: [
          'Datos del empleador, salario mínimo, tasas IPS, divisor del valor hora.',
          'Franja nocturna, multiplicadores de hora extra y recargo/plus nocturno (con toggles de aplicación en feriados y fines de semana).',
          'Completitud de datos: revisa qué empleados no tienen C.I., N° IPS, salario u horario, con importación masiva por plantilla.',
        ],
      },
    ],
  },

  '/configuracion/reglas': {
    title: 'Reglas (constructor de condiciones)',
    intro: 'Motor parametrizable para definir reglas "cuando [condiciones] entonces [acción]" por módulo, sin tocar código.',
    sections: [
      {
        heading: 'Cómo armar una regla',
        items: [
          'Elegí el módulo (asistencia, hora extra, permisos, empleado) y agregá condiciones (campo, operador, valor).',
          'Combiná las condiciones con "todas (Y)" o "alguna (O)".',
          'Elegí la acción (marcar/alertar, requerir aprobación, notificar, bloquear, asignar valor, ajustar monto) y sus parámetros.',
          'Definí prioridad y si la regla está activa.',
        ],
      },
      {
        heading: 'Probar antes de guardar',
        items: [
          'El "Probador" evalúa la regla contra valores de ejemplo y muestra si dispara.',
          'Solo Admin/GTH pueden crear, editar o eliminar reglas.',
        ],
      },
      {
        heading: 'Alertas de reglas (asistencia)',
        items: [
          'La sección desplegable "Alertas de reglas" evalúa las reglas activas del módulo asistencia sobre un período real.',
          'Elegí desde/hasta y presioná "Evaluar": se listan los días y empleados en que cada regla disparó, con su acción.',
          'El contexto de cada día incluye minutos trabajados/tardanza/hora extra, desvíos de entrada/salida, feriado/fin de semana y la reducción vigente de lactancia (lactancia_activa / lactancia_reduccion_min).',
        ],
      },
      {
        heading: 'Alcance actual',
        items: [
          'El módulo asistencia ya evalúa las reglas sobre datos reales (ver "Alertas de reglas").',
          'El consumo en otros módulos (hora extra, permisos, empleado) se irá conectando por fases.',
        ],
      },
    ],
  },

  '/ingresos': {
    title: 'Ingresos / Egresos',
    intro: 'Contratos laborales, período de prueba, alertas de vencimiento y baja formal de personal.',
    sections: [
      {
        heading: 'Contratos',
        items: [
          'Cargá por empleado el tipo de contrato, fecha de inicio/fin, fin del período de prueba y salario.',
          'Cada empleado tiene su historial de contratos; el vigente queda como "activo".',
        ],
      },
      {
        heading: 'Alertas',
        items: [
          'Contratos por vencer y períodos de prueba por terminar dentro de la ventana configurada.',
          'Los tipos de contrato y los días de anticipación de las alertas se configuran en el botón "Configuración".',
        ],
      },
      {
        heading: 'Egreso',
        items: [
          'El botón de egreso da de baja al empleado (pasa a inactivo), guarda fecha y motivo, y cierra sus contratos vigentes.',
          'Solo Admin/GTH/RRHH pueden registrar el egreso y editar la configuración.',
        ],
      },
    ],
  },

  '/lactancia': {
    title: 'Maternidad / Lactancia',
    intro: 'Reducción horaria por lactancia con vigencia y alertas de fin de período.',
    sections: [
      {
        heading: 'Períodos',
        items: [
          'Cargá por empleada la fecha de nacimiento del hijo, el inicio y la reducción diaria (minutos).',
          'Si no indicás fin, se calcula automáticamente como nacimiento + edad máxima (por defecto 24 meses).',
          'Podés cerrar un período o filtrar por vigentes/finalizados.',
        ],
      },
      {
        heading: 'Configuración (parametrizable)',
        items: [
          'Reducción por defecto (ej. 90 min), edad máxima del hijo y días de anticipación de la alerta de fin.',
          'Solo Admin/GTH/RRHH pueden editar la configuración.',
        ],
      },
      {
        heading: 'Alcance actual',
        items: [
          'La reducción queda registrada y disponible (también como campo del constructor de reglas); su aplicación directa al cálculo diario se conecta en una fase posterior para no afectar la liquidación.',
        ],
      },
    ],
  },
}

/**
 * Busca el contenido de ayuda para un pathname dado.
 * Si no hay match exacto, busca el prefijo más largo que coincida.
 */
export function getHelpContent(pathname: string): HelpContent | null {
  if (help[pathname]) return help[pathname]
  // Match por prefijo (ej: /empleados/123 → /empleados)
  const keys = Object.keys(help).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (pathname.startsWith(key + '/') || pathname.startsWith(key)) {
      return help[key]
    }
  }
  return null
}
