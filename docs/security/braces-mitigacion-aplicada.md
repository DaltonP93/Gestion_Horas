# braces CVE-2026-93687 — mitigación APLICADA (parche #72 + gate con excepción temporal)

> Autorizada por el propietario. Es una **aceptación temporal del riesgo**, no una
> eliminación del aviso: `npm audit` **sigue** reportando
> `GHSA-vfj7-8cjw-p6xm` porque el paquete sigue siendo `braces@3.0.3`.
> Investigación y comparación de comportamiento: `docs/security/braces-CVE-2026-93687.md`.
> Vencimiento de la excepción: **2026-10-18**.

## 1. Qué se hizo

1. **Parche adoptado** (defensa en profundidad): PR **micromatch/braces #72**, fijado al
   commit completo **`28d440b5dd449dbf1fe6f3506cf94ecca4d02660`**, licencia **MIT**,
   aplicado vía `overrides` → git en **api, bridge y web**. Agrega `MAX_DEPTH=100` y
   guardas de profundidad en `parse` (llaves/paréntesis) y `compile`/`expand`/`stringify`.
2. **Gate de `npm audit`** con una excepción **temporal, acotada y vencible** para
   **sólo** `GHSA-vfj7-8cjw-p6xm` / `braces@3.0.3`, replicada a los tres paquetes. El
   API conserva además su excepción de node-forge; **Bridge y Web sólo toleran braces**.

No se fusiona, no se despliega, no se activan flags, no se amplía el lote. #243 queda en
`0931878`; #236–#244 intactos.

## 2. Procedencia, licencia y reproducibilidad

- Fuente: `github:micromatch/braces#28d440b5dd449dbf1fe6f3506cf94ecca4d02660` (PR #72,
  **abierto, sin fusionar, sin release**). Licencia **MIT**.
- El `package-lock.json` de cada paquete fija el **commit exacto** con `integrity`
  (`sha512-LcRdbKBiKSOJRndXDk1VR5druLYgvHdr6+BVwMmoX2HEQemPU/vMjtraOQ3RJjN8mPQkDQm85EmBXbMM24IZ2Q==`),
  de modo que `npm ci` reinstala **determinísticamente** el mismo build.
- **Todas** las instancias de braces de cada árbol quedan parcheadas (una copia hoisted
  por árbol; `npm ls braces` las marca `overridden (git+…#28d440b…)`).
- Evidencia: `docs/security/evidence/braces/parche/procedencia.txt`.

## 3. El nombre y la versión reales se conservan — el aviso NO se oculta

El build del parche **sigue reportando `braces@3.0.3`** (el parche no cambia el nombre ni
la versión). Por eso, tras aplicarlo, `npm audit` **sigue** listando el aviso en los tres
paquetes:

| Paquete | braces tras el parche | `npm audit` high | Aviso braces presente |
|---|---|---|---|
| api    | 3.0.3 (git #72, MAX_DEPTH) | 31 | sí — `GHSA-vfj7-8cjw-p6xm` |
| bridge | 3.0.3 (git #72, MAX_DEPTH) | 30 | sí — `GHSA-vfj7-8cjw-p6xm` |
| web    | 3.0.3 (git #72, MAX_DEPTH) | 35 | sí — `GHSA-vfj7-8cjw-p6xm` |

No se usó renombre, cambio artificial de versión ni exclusión de devDependencies para
ocultar el aviso. Informes completos: `docs/security/evidence/braces/parche/npm-audit-{api,bridge,web}.txt`.

## 4. El gate (`api/scripts/ci/audit-gate.js`) y sus protecciones

El mismo evaluador sirve a los tres paquetes (`--root <dir> --exceptions <file>`). Falla —
no tolera — en cualquiera de estos casos (además de las protecciones previas del gate:
informe inválido/con `error`, contadores incoherentes, `via` no resoluble, advisory sin
URL/severidad, high/critical sin advisory compatible):

- **Advisory no declarado** high/critical → falla (Bridge/Web sólo toleran braces; el API,
  braces + node-forge).
- **Cambio de identidad** (paquete, URL/GHSA), **severidad**, **rango** o **versión
  instalada** distintos de lo declarado → falla.
- **Fix publicado del propio paquete** (`fixAvailable===true` o un objeto cuyo `name` es el
  propio paquete) → falla. Un **fix NO-mayor de otro paquete** también → falla (hay que
  tomarlo). Sólo se **tolera con NOTA** un salto **semver-MAJOR de otro paquete** (la
  heurística transitiva de npm, p.ej. `nodemon`/`tailwindcss`): **no** es una versión
  corregida de braces y adoptarlo queda fuera del alcance autorizado.
- **Parche ausente o alterado**: la excepción declara `patch.verify = "braces-depth-guard"`.
  El gate **carga la instalación real** y exige **control positivo** (`a{b,c}d` expande a
  `abd,acd`) **y** rechazo de un patrón de profundidad 101. El **stock** de braces@3.0.3
  **no** rechaza esa profundidad → verificación `ok:false` → **el gate falla**.
- **Vencimiento** (`expires` 2026-10-18) superado → falla.
- **Advisory desaparecido** (ya hay versión corregida publicada) → falla y pide retirar la
  excepción y el override.
- **Más advisories permitidos que excepciones declaradas** → falla.

### Excepciones declaradas
- API: `api/scripts/ci/audit-exceptions.json` — node-forge (vence 2026-11-01) + braces (2026-10-18).
- Bridge: `bridge/scripts/ci/audit-exceptions.json` — sólo braces (2026-10-18).
- Web: `web/scripts/ci/audit-exceptions.json` — sólo braces (2026-10-18).

## 5. Pruebas y evidencia (local)

- **Gate (unit, sintético):** `api/scripts/ci/__tests__/auditGate.test.js` — **35/35**.
  Primero los **rechazos** (parche no verificado / sin verificación = stock como supuesto
  parche; fix del propio paquete; fix no-mayor de otro; `fixAvailable===true`; vencida;
  rango/severidad/versión distintos; otro high además de braces), luego los **controles
  positivos** (braces parcheado + fixAvailable major de otro paquete → pasa con NOTA; API
  node-forge+braces → pasa; excepción extra cuyo advisory no aparece → falla).
- **Verificador real del parche:** `verifyBracesPatch` sobre la instalación real del api →
  `ok:true`; sobre un `braces@3.0.3` **stock** → `ok:false` (“braces aceptó profundidad 101”).
- **`npm ci` (reproducibilidad):** api/bridge/web reinstalan braces@3.0.3 parcheado y el
  gate pasa en los tres (`exit 0`). Evidencia: `docs/security/evidence/braces/parche/gate-output.txt`.
- **Suites:** API **2505** pruebas en UTC / America/Asuncion / Asia/Tokyo; Bridge **452**
  en las tres zonas; Web `tsc --noEmit` OK, jest **522/522**, `next build` OK.
- **CI (HEAD exacto):** ver el cuerpo del PR; los jobs de audit pasan y las unitarias/typecheck/
  build **se ejecutan** (ya no quedan omitidos). Los pasos con Docker (PAdES real) y MySQL
  efímero corren en sus jobs de CI.

## 6. Salida (retiro de la excepción)

En cuanto exista **braces publicado > 3.0.3** (o `micromatch`/`chokidar`/`fast-glob` que lo
incorporen), retirar el `override` y la excepción: el gate ya **falla** cuando aparece un fix
publicado o cuando el advisory desaparece, forzando el retiro. Mientras tanto, la excepción
**no elimina la vulnerabilidad ni limpia el informe de `npm audit`**: es una aceptación
temporal del riesgo, acotada y vencible.
