"""Resolución fail-closed de configuración para el servicio Analytics."""

from collections.abc import Mapping
import os
from pathlib import Path
from typing import Optional

from dotenv import dotenv_values, load_dotenv


ANALYTICS_DIR = Path(__file__).resolve().parent
RELEASE_ROOT = ANALYTICS_DIR.parent
ROOT_ENV_PATH = RELEASE_ROOT / ".env"
ANALYTICS_ENV_PATH = ANALYTICS_DIR / ".env"
API_ENV_PATH = RELEASE_ROOT / "api" / ".env"


def load_runtime_environment(
    root_env_path: Path | str = ROOT_ENV_PATH,
    analytics_env_path: Path | str = ANALYTICS_ENV_PATH,
) -> None:
    """Carga archivos no versionados sin sobreescribir el entorno del proceso."""
    # El archivo específico tiene prioridad sobre el .env compartido.
    load_dotenv(Path(analytics_env_path), override=False)
    load_dotenv(Path(root_env_path), override=False)


def _first_nonempty(*values: Optional[str]) -> Optional[str]:
    return next((value for value in values if value), None)


def resolve_api_key(
    environ: Mapping[str, str] | None = None,
    api_env_path: Path | str = API_ENV_PATH,
) -> Optional[str]:
    """Resuelve la clave compartida sin defaults ni exposición en logs/PM2."""
    source = os.environ if environ is None else environ
    direct = _first_nonempty(
        source.get("API_KEY"),
        source.get("ANALYTICS_API_KEY"),
    )
    if direct:
        return direct

    # Compatibilidad con el despliegue PM2: api/.env es 0600 y ya contiene
    # ANALYTICS_API_KEY para el BFF. dotenv_values no exporta las otras claves.
    path = Path(api_env_path)
    if not path.is_file():
        return None
    values = dotenv_values(path)
    return _first_nonempty(values.get("ANALYTICS_API_KEY"))
