# Seguridad — SisHoras

> **Actualizado:** 2026-09-06 · Fuente: auditoría de seguridad (Agente 4) sobre `main @ 078cd67`, modo read-only.
> Severidad P0–P3. Evidencia `ruta:línea`. Estado a la fecha en `main` (los PRs abiertos pueden ya mitigar algunos, se indica).

## Hallazgos

| # | Hallazgo | Sev | Evidencia | Estado |
|---|---|---|---|---|
| H1 | Credencial demo `admin/Admin1234!` con hash en repo | P1 | `database/init.sql:206-210` | PRESENTE |
| H2 | JWT + refresh en `localStorage` (robables por XSS) | P1 | `web/src/lib/api.ts`, `web/src/lib/socket.ts` | PRESENTE |
| H3 | `access_token` en URL de descargas y logueado (`morgan('combined')`) | P1 | `api/src/middleware/auth.js:18-20`, `api/src/index.js:113` | PRESENTE |
| H4 | Sesión no vinculada a `jti`/session; access token stateless 1h no revalida `active`/empresa | P1 | `api/src/middleware/auth.js:13-31`, `authController.js:22-35` | PRESENTE |
| H5 | WebSocket sin revalidación tras handshake | P2 | `api/src/socket/socketServer.js:31-53` | PRESENTE |
| H6 | Auditoría sin allowlist de claves (PII/texto libre) | P2 | `api/src/services/audit.js` | **MITIGADO en PR #192** (no en main) |
| H7 | Fuga de `err.message` en 5xx | P2 | `selfCheckin.js`, `embed.js`, `reportsBuilder.js` | PRESENTE |
| H8 | Sin lockout por cuenta (solo rate-limit por IP) | P2 | `api/src/index.js:116-144` | PARCIAL |
| H9 | `super_admin`/`admin` bypass amplio | P3 | `api/src/middleware/auth.js:38,86` | PRESENTE (por diseño) |
| H10 | `jwt.verify` sin fijar `algorithms` en socket/refresh | P3 | `socketServer.js:35`, `authController.js:116` | PRESENTE |
| H11 | 2FA revela validez de contraseña antes del 2º factor | P3 | `authController.js:65-69` | PRESENTE (menor) |
| H12 | CORS permite requests sin `origin` con credentials; hosts hardcodeados | P3 | `api/src/index.js:92-105` | PRESENTE (bajo) |

## Reconciliación histórica (¿sigue hoy?)

| Ítem | Estado actual |
|---|---|
| Revalidación WS postergable | SIGUE (H5) |
| Sesión no vinculada a JWT sub | SIGUE (H4) |
| Asserts `or True`/permisivos | NO ENCONTRADO en muestra |
| Credenciales demo | SIGUE (H1) |
| Secretos inseguros por defecto | MITIGADO en prod (`config/env.js` exige ≥32 chars) |
| PIN en texto plano | NOT_PRESENT (auth bcrypt; QR self-checkin token TTL 5min) |
| JWT en localStorage | SIGUE (H2) |
| Token WS en URL | RESUELTO (va por `handshake.auth`); el `access_token` HTTP sí va en URL (H3) |
| Falta CSRF | N/A (bearer en header, sin cookies de sesión) |
| Falta rate limiting | MITIGADO |
| Falta MFA | MITIGADO (TOTP opcional) |
| Sesiones tras suspender empresa | SIGUE (H4: access vivo 1h; refresh sí valida `active`) |

## att2000 READ-ONLY

CONFIRMADO. `config/att2000.js` solo lectura/introspección; sin `writeCheckinOut`; sin
`INSERT/UPDATE/DELETE` en `att2000Legacy.js`; sin flag `ATT2000_WRITE_ENABLED`. Riesgo
residual: conexión `sa`/`encrypt:false`/`trustServerCertificate:true` por defecto → usar
usuario `db_datareader` y TLS.

## Inyección / uploads

- SQL: consultas parametrizadas; identificadores con allowlist (`reportsBuilder.js`, `employees.js`, `reports.js`). **MITIGADO.**
- Uploads: nombre generado en servidor, content-type validado, límite 800KB (`selfCheckin.js`). Revisar `permissions.js`/`me.js` (multer) a fondo.
- Importadores CSV/MDB: no auditados en profundidad (pendiente).

## P0/P1 explotables priorizados
1. H1 — admin default (takeover trivial si no se rota en go-live).
2. H3 — token en URL + logs (explotable sin XSS).
3. H2 — token persistente en localStorage (1 XSS = sesión 7 días).
4. H4/H5 — revocación inefectiva tras suspender/cambiar contraseña.

## Pruebas negativas/adversariales recomendadas (a implementar)
Revocación tras `active=0`; expiración/suspensión en WS; replay de refresh rotado; ausencia de
`access_token=` en logs; IDOR multi-depto en `/employees/:id`, reportes, overtime; matriz RBAC
403 por rol; lockout por cuenta; bypass 2FA y anti-replay OTP; test que falle si existe hash de
`Admin1234!` en entorno prod; uploads maliciosos; CORS origin no permitido; `audit_events.details`
sin claves fuera de allowlist; regresión estática att2000 read-only.
