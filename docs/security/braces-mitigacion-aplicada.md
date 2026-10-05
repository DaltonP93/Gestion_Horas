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

## 2. Procedencia, licencia e integridad (tres cosas distintas)

- Fuente: `github:micromatch/braces#28d440b5dd449dbf1fe6f3506cf94ecca4d02660` (PR #72,
  **abierto, sin fusionar, sin release**). Licencia **MIT**.
- **Commit fijado:** el `package-lock.json` de cada paquete fija el **commit exacto**
  (`"resolved": "git+ssh://…/micromatch/braces.git#28d440b…"`), de modo que `npm ci`
  reinstala el mismo árbol de commit.
- **SRI NO verificado por npm:** para una dependencia **git**, npm imprime
  `npm warn skipping integrity check for git dependency …`. El lockfile trae un campo
  `integrity` (`sha512-…`) **pero npm NO lo verifica** al instalar el git dep; por tanto
  **no es un SRI efectivamente comprobado**. No debe presentarse como tal.
- **Verificación propia de archivos (lo que SÍ acredita identidad):** huellas **SHA-256
  por archivo** del parche en la revisión aprobada
  (`api/scripts/ci/braces-patch-fingerprints.json`), que el gate comprueba sobre
  **todas** las copias instaladas (incl. anidadas) en cada ejecución. Esto, y no el SRI
  de npm, es lo que acredita que los archivos instalados son los de `28d440b`.
- **Todas** las instancias de braces de cada árbol quedan parcheadas; `npm ls braces`
  las marca `overridden (git+…#28d440b…)`.
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
- **Forma de `fixAvailable` validada estrictamente:** sólo se aceptan `false`/`true` o el
  objeto canónico `{name, version, isSemVerMajor}`; cualquier otra cosa (string como
  `"unexpected"`, número, objeto mal formado) → **falla**.
- **Fix publicado del propio paquete** (`fixAvailable===true` o un objeto cuyo `name` es el
  propio paquete) → falla. Un **fix NO-mayor de otro paquete** también → falla (hay que
  tomarlo). Se **tolera con NOTA** un salto **semver-MAJOR de otro paquete** (heurística
  transitiva de npm, p.ej. `nodemon`/`tailwindcss`) **sólo** si la excepción lo declara
  (`acceptTransitiveMajorFix: true`, presente **sólo** en braces). **node-forge no lo
  declara**, así que para él **cualquier** `fixAvailable` sigue fallando (regla base
  conservada).
- **Parche ausente o alterado**: la excepción declara `patch.verify = "braces-patch-fingerprint"`.
  El gate verifica la **identidad por huellas SHA-256** de **todas** las copias (incl.
  anidadas) contra la revisión aprobada **y**, como cross-check de comportamiento, exige
  controles positivos (`a{b,c}d`→`abd,acd`, `{1..3}`, `foo/{a,b}`), aceptación dentro del
  límite, y rechazo **de profundidad** (error que menciona `depth`, no una excepción
  arbitraria) en **parse** (`nest(101)`) **y** en **compile** sobre AST suministrado
  directamente (`compile(deepAst(150))`). Así, ni el **stock** de braces@3.0.3 ni un parche
  **con la guarda de compile eliminada** pasan la verificación.
- **Vencimiento** (`expires` 2026-10-18) superado → falla.
- **Advisory desaparecido** (ya hay versión corregida publicada) → falla y pide retirar la
  excepción y el override.
- **Más advisories permitidos que excepciones declaradas** → falla.

### Excepciones declaradas
- API: `api/scripts/ci/audit-exceptions.json` — node-forge (vence 2026-11-01) + braces (2026-10-18).
- Bridge: `bridge/scripts/ci/audit-exceptions.json` — sólo braces (2026-10-18).
- Web: `web/scripts/ci/audit-exceptions.json` — sólo braces (2026-10-18).

## 5. Pruebas y evidencia (local)

- **Gate (unit, sintético):** `api/scripts/ci/__tests__/auditGate.test.js` — **36/36**.
  Primero los **rechazos** (parche no verificado / sin verificación / sin huellas; fix del
  propio paquete; fix no-mayor de otro; `fixAvailable===true`; vencida; rango/severidad/
  versión distintos; otro high además de braces), luego los **controles positivos** (braces
  parcheado + fixAvailable major de otro paquete → pasa con NOTA; API node-forge+braces →
  pasa; excepción extra cuyo advisory no aparece → falla).
- **Reproducciones de endurecimiento** `api/scripts/ci/__tests__/auditGateHardening.test.js`
  — **5/5** (fallaban sobre `85a8510`, pasan tras el endurecimiento): #1 parche con la
  guarda de **compile** eliminada (mantiene parse, pierde compile) → el gate lo **rechaza**;
  #2 node-forge con fixAvailable major de otro paquete → **falla**; #3 fixAvailable mal
  formado (`"unexpected"`, `1`) → **falla**. Evidencia antes/después en
  `docs/security/evidence/braces/parche/negativos-antes-85a8510.txt` y `negativos-despues.txt`.
- **Verificador real del parche:** `verifyBracesPatch` (huellas + comportamiento) sobre la
  instalación real del api → `ok:true`; sin huellas de referencia → `ok:false`; sobre un
  `braces@3.0.3` **stock** o un parche con la guarda de compile eliminada → `ok:false`.
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
