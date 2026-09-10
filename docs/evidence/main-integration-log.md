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

### Ola 2 — Nocturno (`3f89486`)
| PR | `main` tras merge |
|---|---|
| #196 total mensual por motor | `8247016` |
| #204 semanal/diario/analítica | `add9a24` |
| #205 self-service `/me` | `038e8ce` |
| #197 recibo self-service | `5e9f516` |
| #200 export planilla + API (gth ve salario) | `3f89486` |

### Ola 3 — Módulos/export (`78924de`)
| PR | `main` tras merge |
|---|---|
| #178 export CSV marcaciones (util) | `2e3c03d` |
| #179 vacaciones CSV | `b47331a` |
| #180 encuestas CSV | `96ad309` |
| #181 banco-horas filtro+CSV | `9138463` |
| #187 horas extra CSV + decide-batch | `023ccab` |
| #177 capacitaciones editar (web) | `37c2c6e` |
| #188 reporte semanal CSV (api) | `eb47c0a` |
| #162 relojes ZKTeco UI | `be590cb` |
| #163 zkteco read hardening | `78924de` |

### Ola 4 — FASE E read-only (`1a5e184`)
| PR | `main` tras merge |
|---|---|
| #174 guard estático read-only | `a7997d8` |
| #175 gate tri-estado | `2d0862c` |
| #176 matriz fail-closed writers | `3fcb36f` |
| #182 drift-checker FASE C | `54bafed` |
| #183 wrapper phase-e:preflight + runbook | `b4b6a8b` |
| #184 golden motor NO-GO | `0e9deb6` |
| #186 golden degradación loadWorkdayConfig | `394a842` |
| #164 huella fiel gate de impacto | `1a5e184` |

### Docs
| PR | `main` tras merge |
|---|---|
| #206 snapshot consolidado (este log) | `79c01d5` |
| #214 baseline canónico (AI_HANDOFF/INTEGRATION_PLAN) | `a7e3f91` |

### DevOps — destrabar despliegue (`6b20e56`, autorizado 2026-09-09)
| PR | `main` tras merge |
|---|---|
| #213 nginx compose + `Dockerfile.migrate` + restore/runbook + healthcheck TCP mysql | `6b20e56` |

- **#213** cierra los 3 bloqueos de `DEPLOYMENT.md`: (1) nginx del compose (montaje fantasma `./nginx/`
  → `deploy/nginx.compose.conf` a nombres de servicio), (2) imagen one-shot `Dockerfile.migrate` (profile
  `tools`, corre el runner real con la guardia #212), (3) `scripts/restore-mysql.sh` + `deploy/DEPLOY-RUNBOOK.md`.
  Se sumó el **healthcheck TCP autenticado** de `mysql` (`SELECT 1` vía `-h 127.0.0.1`, `start_period 30s`),
  que evita el falso positivo de `mysqladmin ping` durante el init y hace fiable `depends_on: service_healthy`.
- **Es aditivo:** no toca prod, no activa flags/writers, att2000 READ-ONLY, sin migraciones aplicadas.
  **El levantamiento real del stack y la prueba de restore quedan para ops** (sin Docker en el entorno);
  la §5.1 del runbook deja el procedimiento de validación en entorno descartable.
- **CI:** run #727 (PR, cabeza `9d20475`) verde en la cadena completa; run #728 (push a `main`, `6b20e56`)
  re-ejecuta el mismo código (los archivos de #213 no los ejercita CI) → verde esperado.

### Ola 5 — FASE F multiempresa (`d88fe09`, autorizado 2026-09-09)
> El propietario autorizó explícitamente ("Sí, fusionar todo") el merge de toda la cadena FASE F,
> tras la preparación (rebase sobre `main` + CI verde) documentada en `docs/evidence/fase-f-review-prep.md`.
> Merge base-first, retarget de cada apilado al `main` recién avanzado, método `merge`, `mergeable_state:
> clean` verificado por PR. **Cero conflictos en el tren de merge** (resueltos antes, en la preparación).

**Núcleo (multiempresa — migraciones 076–080):**
| PR | `main` tras merge |
|---|---|
| #158 F1 gobierno/orgScope/auditoría (076/077) | `18e40ae` |
| #159 F2 candidatos/asignaciones (078) | `12156c0` |
| #160 F3 calendario/jornada 3-estados (079) | `a6d5217` |
| #161 F4 nómina sandbox global (080) | `22ede82` |

**F+ UI:**
| PR | `main` tras merge |
|---|---|
| #167 historial organizativo (asignaciones) | `568983d` |
| #168 ciclo de vida períodos de nómina | `3993772` |
| #169 catálogo de conceptos versionados | `879035c` |
| #170 autoría de calendarios + excepciones | `c899dff` |
| #171 visor de jornada efectiva (read-only) | `7721d1d` |
| #172 selector de alcance en candidatos | `b49c149` |
| #173 headcount + evidencia de snapshot | `9967c0f` |
| #185 ayuda contextual (HelpButton) | `e213cc5` |

**CI:**
| PR | `main` tras merge |
|---|---|
| #189 job idempotencia 072→075 (MySQL efímero) | `d88fe09` |

- **CI de la cabeza final (`d88fe09`, run #773): verde en la cadena completa** — API/Web/Bridge 3 TZ + **DB
  migraciones (aplica 076–080 por primera vez en el tronco, idempotente, `--status` read-only)** + Analytics
  + gate `npm audit`. El job dedicado `migrations-072-075-idempotency` (#189) también verde.
- **Invariantes:** migraciones 076–080 quedan en el repo pero **NO aplicadas en prod**; writers
  fail-closed (`GOVERNANCE/PEOPLE/CALENDAR/PAYROLL_WRITE_ENABLED` = `false`); att2000 READ-ONLY;
  `daily_summary` sin tocar. **Aplicar migraciones en prod + activar multiempresa = paso operativo aparte,
  requiere OK expreso del propietario.**

## Resumen final
- **`main` avanzó de `078cd67` (#157) a `d88fe09`** con **49 PRs** (Olas 1–4 + #210 + #206 + #214 docs +
  #213 DevOps + **Ola 5 FASE F: 13 PRs**).
- **CI de la cabeza:** cadena completa (API/Web/Bridge 3 TZ + DB MySQL efímero + Analytics + gate `npm audit`) verde (run #773).
- **Fuera todavía, sin fusionar por bloqueo real:** firma #198/#199/#201/#203 (081/082), #202 (083 + conflicto FASE E), #191 (dup de #206), #209 (ADR cookies, implementación no autorizada).
- **Invariantes preservadas:** sin activar flags/writers, sin recalcular `daily_summary`, att2000 READ-ONLY, **migraciones aplicadas sólo en CI efímero, nunca en prod**.
