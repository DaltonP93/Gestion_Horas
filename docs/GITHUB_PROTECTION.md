# Protección recomendada para main

> Estado verificado el 2026-09-23: main no está protegida. Este documento no
> cambia la configuración de GitHub; la activación requiere aprobación aparte.

## Ruleset mínimo

Crear un ruleset dirigido a la rama main con estas condiciones:

- exigir pull request antes de fusionar;
- exigir todos los checks aunque el propietario haga el merge;
- exigir resolución de todas las conversaciones;
- exigir una aprobación sólo cuando exista un segundo mantenedor;
- exigir que la rama esté actualizada con main;
- exigir todos los jobs vigentes del workflow CI;
- bloquear force-push y eliminación de main;
- permitir bypass sólo al propietario para incidentes documentados.

No exigir commits firmados hasta confirmar que el flujo operativo y las cuentas
de automatización pueden firmar; activarlo antes podría bloquear despliegues.

## Gate antes de activar

1. Confirmar que el PR operativo de backup/restore tiene todos los checks verdes.
2. Confirmar que el propietario conserva bypass de emergencia.
3. Si sólo existe un mantenedor, no exigir aprobación ajena todavía.
4. Probar un PR pequeño y su merge.
5. Verificar que un push directo a main queda rechazado.
6. Registrar captura o salida de la configuración aplicada.

## Visibilidad del repositorio

El repositorio es público. La protección de rama evita cambios no revisados,
pero no oculta documentación. Antes de agregar inventario, IP, credenciales,
nombres personales o topología detallada, hacer privado el repositorio o
sanear esos datos. Ningún secreto debe almacenarse en Git, issues o Actions.
