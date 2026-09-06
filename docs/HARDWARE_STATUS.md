# Estado de hardware — SisHoras

> **Actualizado:** 2026-09-06 · Verificado por auditoría read-only sobre `main @ 078cd67`.

## Regla de honestidad de hardware

No se afirma que el sistema controle hardware que no esté probado en banco/instalación real.
Se separa siempre: CRUD web · motor de decisión · simulador · codec · transporte · gateway ·
sincronización · eventos físicos · apertura física.

## Lo que realmente hay

| Capacidad | Estado | Evidencia |
|---|---|---|
| Relojes ZKTeco como **fuente de marcaciones** (PUSH/ADMS) | Soportado (recepción) | `bridge/` (puerto 8080 PUSH, 8081 API), `docs/zkteco-push-setup.md` |
| Bridge con outbox durable (SQLite) + Redis Streams | Configurado / probado local (tests bridge en CI, 3 TZ) | `docs/bridge-outbox.md`, `bridge/` `better-sqlite3` |
| Lectura de `att2000` (SQL Server) | Soportado, **READ-ONLY** | `api/src/config/att2000.js` (sin writers) |
| Auto-polling att2000 / ZKTeco | **OFF por defecto** (kill-switch) | `ATT2000_AUTO_PULL_ENABLED=false`, `ZKTECO_AUTO_POLL=false` |

## Lo que NO existe (NOT_PRESENT — fuera de dominio)

- Control de acceso físico: apertura remota de puertas, comando de cerraduras/relés.
- PIN de acceso / tarjetas RFID como credencial de puerta, anti-passback, interlock, multicard, "primera tarjeta".
- Gateway de control de acceso, identidad de servicios de gateway, borrado de tarjetas revocadas en placa.
- Eventos físicos de puerta, doble aprobación de comando de apertura, anti-replay de comandos.
- Driver UDP experimental, opcodes/CRC/cifrado propietario de controladoras.

Verificación: `rg -i 'anti-passback|interlock|multicard|wiegand|relay|apertura remota|door.*open'`
sin coincidencias funcionales; las únicas menciones a "puerta" son metafóricas en comentarios.

## Requisito para soportar hardware real (si algún día se pide)

Modelo exacto · documentación/protocolo válido · SDK/DLL o captura legítima · banco de pruebas ·
evidencia anonimizada · resultado repetible. Nada de esto está presente hoy. No activar por
defecto ningún driver experimental. No inventar opcodes/CRC/layouts.
