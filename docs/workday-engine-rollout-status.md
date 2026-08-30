# Estado — Workday Engine / Configuración laboral

Última actualización: FASE C backend en desarrollo.

## Fases

- [x] **FASE A — WorkdayEngine / Marcadas**
  - wall-clock;
  - pairing type-aware;
  - cross-midnight;
  - historical_fallback;
  - anomalías;
  - memoria/Marcadas;
  - tests golden.

- [x] **FASE B — daily_summary / ingesta**
  - dailySummaryEngine;
  - writer detrás de flag;
  - unknown fail-safe;
  - locks/reintentos;
  - ATT2000 read-only;
  - PR #147 + follow-up #148 integrados en main.

- [ ] **FASE C — configuración laboral backend**
  - rama: `claude/workday-config-phase-c`;
  - modelo histórico inmutable;
  - vigencias sin solapamiento;
  - perfil laboral;
  - effective-config;
  - APIs + RBAC + auditoría;
  - migración 075;
  - tests/CI/Codex pendientes de cierre.

- [ ] **FASE D — UI RR.HH.**
  - no iniciada;
  - deberá consumir exclusivamente las APIs de FASE C;
  - cambios históricos siempre con fecha efectiva y advertencia.

- [ ] **FASE E — auditoría / migraciones / rollout**
  - no iniciada;
  - sin deploy ni flags hasta completar dry-run.

## Gates actuales

Durante FASE C:

- NO deploy.
- NO ejecutar 072/073/074/075 en producción.
- NO activar `WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED`.
- NO activar `WORKDAY_ENGINE_STATUS_074_ENABLED`.
- NO recalcular producción.
- NO continuar reparación histórica febrero 2025+.
- NO modificar `attendance_logs` históricos.
- ATT2000 estrictamente READ-ONLY.

## Base

FASE C comenzó únicamente después de confirmar que `main` contiene el merge
de PR #148 y, por lo tanto, el commit revisado `b671d5a142...`.
