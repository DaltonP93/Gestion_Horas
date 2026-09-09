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

| Ola | PR | Método | Merge commit | CI post-merge | Estado |
|---|---|---|---|---|---|
| — | (partida) | — | `078cd67` | 3 jobs verde | baseline |

_(se completa a medida que se fusiona)_
