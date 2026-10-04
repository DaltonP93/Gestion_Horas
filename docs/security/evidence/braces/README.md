# Evidencia — evaluación del parche micromatch/braces #72

Comparación de comportamiento entre `braces@3.0.3` (stock) y el PR #72 fijado en
`28d440b5dd449dbf1fe6f3506cf94ecca4d02660`, en entorno aislado con Node 22.

## Procedencia y comandos (reproducible)

```
# stock
npm install braces@3.0.3 --ignore-scripts --no-audit --no-fund
# parche, revisión fija (PR #72)
npm install "github:micromatch/braces#28d440b5dd449dbf1fe6f3506cf94ecca4d02660" \
  --ignore-scripts --no-audit --no-fund
# → ambos resuelven a braces@3.0.3, licencia MIT; el build del parche
#   sigue reportando versión 3.0.3 (clave para el audit; ver informe §6)
node eval.js   # salida en eval-output.txt
```

- `eval.js`: controles válidos (A), límite de profundidad por parseo (B), opción
  `maxDepth` que intenta superar el tope (C), paréntesis anidados (D) y AST
  suministrado directamente a `compile` (E).
- `eval-output.txt`: resultado observado en **estas** pruebas (distintas de las
  declaradas por el PR upstream, p. ej. `test/depth-guards.js`).

Ver el análisis completo en `docs/security/braces-CVE-2026-93687.md`.
