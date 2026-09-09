# Log de integración a `main` — Olas 1–4 + docs

> **Autorización:** el propietario (DaltonP93) autorizó el 2026-09-08 avanzar a `main`
> el alcance **Olas 1–4 + #206** (sin FASE F). Firma (#198/#199/#201/#203), #202 y
> cookies (#209) quedan **fuera** (bloqueo real). Cada merge se ejecuta como el
> propietario, con la auditoría de release-readiness (agente completo) en GO.
> **Base de partida:** `main @ 078cd67` (#157).
>
> Este archivo documenta el avance real (SHA, orden, CI). Se actualiza por ola.

## Orden autorizado
```
Ola 1: #190 · #194 · #212 · #208 · #207 · #192 · #165 · #166 · #195
Ola 2: #196 · #204 · #205 · #197 · #200
Ola 3: #178 · #179 · #180 · #181 · #187 · #177 · #188 · #162 · #163
Ola 4: #174 · #175 · #176 · #182 · #183 · #184 · #186 · #164
Docs:  #206
Aparte: #210 (rebase tras #194 — multer 2.x verificado en runtime), #213 (DevOps)
```
Reglas: base-first en cadenas (retarget del apilado a `main` tras fusionar su base);
método `merge` (merge commit); verificar `main` verde entre olas.

## Evidencia previa (pre-merge, ya registrada)
- Auditoría release-readiness (agente completo, read-only): **GO** Olas 1–4 + #206;
  merges de prueba secuenciales limpios salvo #210 (lockfiles). Invariantes OK
  (sin activación de flags/writers, att2000 READ-ONLY, fixes de seguridad reales,
  guardia #212 sólida, sin migraciones 076–083).
- #210: `multer 1.x→2.x` verificado en runtime (upload-routes 35 tests + api 75/1292).

## Estado de ejecución

| Ola | PR | Método | `main` tras el merge | Estado |
|---|---|---|---|---|
| — | (partida #157) | — | `078cd67` | baseline |
| 1 | #190 CI trigger claude/** | merge | `8a5a2c6` | ✅ merged |
| 1 | #194 migr.020 + logRedaction + CI MySQL/Analytics | merge | `cf59602` | ✅ merged |
| 1 | #212 guardia de monotonicidad | merge | `e84bd44` | ✅ merged |
| 1 | #208 H1 preflight | merge | `0705b70` | ✅ merged |
| 1 | #207 JWT HS256 + 5xx | merge | `f22a6e7` | ✅ merged |
| 1 | #192 authz + PII + fix att2000 | merge | `16f5db6` | ✅ merged |
| 1 | #165 insertId | merge | `7fcd771` | ✅ merged |
| 1 | #166 auditoría egreso sin PII | merge | `b190a21` | ✅ merged |
| 1 | #195 saneo dominio | merge | `17c6814` | ✅ merged |

| 1+ | #210 deps: gate npm audit ALTO + bumps CVE | merge | `324b648` | ✅ merged |

**CI de `main` tras Ola 1:**
- Run #694 sobre `17c6814` **falló** — pero **sólo en el step `npm audit (nivel alto)`** (gate que #194 activó): apareció un HIGH nuevo `nodemailer <=9.1.0` (advisory 2026-09-09) en api y un HIGH en web (next 16.2.11). Los jobs de **código** pasaron: **DB migraciones MySQL efímero ✅** (aplica 002→…, idempotente, `--status` read-only, guardia #212 sin falso positivo) y **Analytics ✅**. Los unit tests quedaron *skipped* porque el step de audit corta antes.
- **Fix-forward = #210** (reconstruido sobre `17c6814`): `npm audit fix` en api (nodemailer→9.1.1), web (next→16.3.4, `next build` OK con el fix de #194) y bridge; + bumps CVE multer/axios/python-jose. Verificado local: api 88/1391, bridge 452, web build; `npm audit --audit-level=high` = **0** en api/web/bridge. → `main` `324b648`, run #698 (a confirmar verde antes de la Ola 2).

_(Olas 2–4 + #206 se completan a medida que se fusionan.)_
