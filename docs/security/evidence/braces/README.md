# Evidencia — evaluación del parche micromatch/braces #72

Comparación de comportamiento entre `braces@3.0.3` (stock) y el PR #72 fijado en
el commit completo `28d440b5dd449dbf1fe6f3506cf94ecca4d02660`, en entorno aislado
con **Node 22**. Esta evidencia es **reproducible fuera de la sesión**: `eval.js`
no contiene rutas absolutas; recibe las dos instalaciones por variable de entorno
o por argumento.

## 1. Preparar DOS instalaciones aisladas

Crear un directorio limpio (fuera del repo) con dos subcarpetas independientes,
cada una con su propio `node_modules/braces`. Usar **Node 22** y `--ignore-scripts`
en ambos casos (el parche se instala desde git y no debe ejecutar scripts).

```sh
node --version          # debe ser v22.x

WORK="$(mktemp -d)"     # directorio limpio, fuera del repositorio

# (a) stock: braces@3.0.3 publicado
mkdir -p "$WORK/stock" && cd "$WORK/stock"
npm install braces@3.0.3 --ignore-scripts --no-audit --no-fund

# (b) parche: PR micromatch/braces #72, revisión fija (SHA completo)
mkdir -p "$WORK/patched" && cd "$WORK/patched"
npm install "github:micromatch/braces#28d440b5dd449dbf1fe6f3506cf94ecca4d02660" \
  --ignore-scripts --no-audit --no-fund
```

Ambas resuelven a `braces@3.0.3`, licencia MIT; el build del parche **sigue
reportando versión 3.0.3** (clave para el audit; ver informe §6). Cada `<dir>`
que se pasa a `eval.js` es la carpeta que **contiene** `node_modules/braces`
(es decir `$WORK/stock` y `$WORK/patched`).

## 2. Ejecutar la evaluación

`eval.js` **no instala nada**: lee las dos instalaciones ya preparadas. Las rutas
se indican por variable de entorno (preferido) o por argumento:

```sh
BRACES_STOCK="$WORK/stock" BRACES_PATCHED="$WORK/patched" \
  node eval.js | tee eval-output.txt
# equivalente posicional:
# node eval.js "$WORK/stock" "$WORK/patched" | tee eval-output.txt
```

(Para regenerar la evidencia versionada, redirigir a este mismo directorio:
`... | tee docs/security/evidence/braces/eval-output.txt` desde la raíz del repo.)

### Qué comprueba (ASERCIONES, no sólo impresión)

Los resultados esperados son **aserciones**: cualquier incumplimiento termina el
proceso con **exit 1** (exit 2 si faltan las rutas). Las comprobaciones:

- **A. Controles válidos** — el parche debe producir **la misma expansión** que el
  stock en 11 patrones válidos (igualdad exacta).
- **B. Profundidad por parseo** — `nest(100)` se **acepta** dentro del límite;
  `nest(101)` y `nest(500)` se **rechazan**.
- **C. Opción `maxDepth`** — no puede **superar** el tope: `nest(150)` con
  `{maxDepth:200}` y con `{maxDepth:100000}` sigue **rechazándose**.
- **D. Paréntesis anidados** — `parens(100)` se **acepta**; `parens(101)` se **rechaza**.
- **E. AST directo a `compile`** — un AST anidado construido a mano se pasa
  **directamente a `compile`** (sin `parse`): profundidad 50 **compila**, profundidad
  150 se **rechaza**. (Sólo se prueba `compile`, no `stringify`.)

### Control negativo

La Fase 2 usa el **stock como supuesto parche** y exige que **falle** los criterios
de rechazo (acepta profundidades que un parche debería rechazar). Si el stock los
cumpliera, la suite no distinguiría una implementación no corregida; por eso el
control negativo que **no** falla se cuenta como fallo y fuerza exit 1.

- `eval-output.txt`: salida observada en **estas** pruebas (distintas de las
  declaradas por el PR upstream, p. ej. `test/depth-guards.js`).

Ver el análisis completo en `docs/security/braces-CVE-2026-93687.md`.
