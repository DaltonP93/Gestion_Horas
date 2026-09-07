# Evidencia — ensayo LOCAL de integración lote 1 (#190→#194→#207→#192→#208)

> Artefacto de auditoría (Rule 5/6): ensayo **local** en un worktree **descartable** desde `origin/main`.
> **No** es CI remoto del stack; **no** hubo push ni merge a ramas remotas. Fecha: 2026-09-07.

## SHAs exactos usados (confirmados antes de usar)
| Base/PR | Rama | SHA |
|---|---|---|
| base | `main` | `078cd67bb5241de0b962afa2b1e0b87358607478` |
| #190 | `claude/ci-trigger-claude-branches` | `2f8198325ff59584cb929200fbc285be1baebb56` |
| #194 | `claude/ops-hygiene-secrets-migration-ci` | `e5275069ad4705e0bd16c706082afa48c162b3c1` |
| #207 | `claude/sec-hygiene-logs-jwt-5xx` | `c22f962f4f470d4b043145a29eb2d32fd7622638` |
| #192 | `claude/sec-authz-scope-audit-sqlfix` | `0d7f37756a0c743640ad58c6c64a39420e0670ff` |
| #208 | `claude/sec-h1-default-credential-preflight` | `0c3022e590d9d1defae1fb871923261b0506cf6f` |

## Comandos (reproducibles)
```bash
git worktree add --detach <tmp> 078cd67
for sha in 2f81983 e527506 c22f962 0d7f377 0c3022e; do
  git -C <tmp> merge --no-ff --no-edit "$sha"   # registrar conflicto si rc!=0
done
git -C <tmp> rev-parse HEAD^{tree}              # tree SHA determinista del stack
# Suites por componente:
(cd <tmp>/api    && npm ci && for tz in UTC America/Asuncion Asia/Tokyo; do TZ=$tz npx jest; done)
(cd <tmp>/bridge && npm ci && npm test)
(cd <tmp>/web    && npm ci && npm test && npm run build)
(cd <tmp>/analytics && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && python -m py_compile main.py && python -c "import main; assert main.app")
# DB efímero (con #194 presente): init.sql -> migrate --status (RO) -> migrate -> migrate (idempotencia)
```

## Resultado

- **Merges: 0 conflictos** en la secuencia #190→#194→#207→#192→#208.
- **TREE SHA final (determinista) del stack:** `981206fa8a7f8ea7431f2a19e3fdab3e25ec0529`
  (el commit HEAD del stack temporal es no-determinista por timestamps; el **tree** es el identificador estable).

| Suite | Comando | Resultado |
|---|---|---|
| API (jest) | `npx jest` en UTC / America\_Asuncion / Asia\_Tokyo | **84 suites / 1370 tests** verde en las 3 TZ |
| Bridge | `npm test` | **14 suites / 452 tests** verde |
| Web | `npm test` + `npm run build` | **32 suites / 437 tests** verde + **build OK** |
| Analytics | `pip install` + `py_compile` + `import main` | **OK** (1er intento: `ReadTimeoutError` de red a pythonhosted; **reintento OK** — flake de red del entorno, no del código) |
| DB efímero (MySQL 8) | `migrate --status` (RO) → `migrate` → `migrate` | `--status` read-only (73 pendientes) → **73 migraciones aplicadas** → 2ª corrida **idempotente** (`Nada por aplicar`) |

## #193 SUPERSEDED (verificado)
El stack (con #194) ya contiene el tipo `WorkdayConfigSavePayload` en `web/src/lib/workdayConfig.ts`;
`git merge <#193>` sobre el stack **conflicta** en las mismas líneas y no aporta cambio nuevo (merge abortado).

## Limitaciones (honesto)
- Ensayo **local**, no CI remoto del stack fusionado. **No** se afirma CI remoto del stack.
- No se rebasó ni pusheó #190/#194/#207/#192; el único worktree creado fue eliminado tras el ensayo.
- Cubre lote 1; FASE F (076–083) y el resto de lotes quedan fuera de este ensayo.
