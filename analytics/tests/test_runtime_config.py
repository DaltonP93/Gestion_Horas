import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from runtime_config import load_runtime_environment, resolve_api_key


class RuntimeConfigTests(unittest.TestCase):
    def test_api_key_has_precedence_over_alias(self):
        value = resolve_api_key(
            {"API_KEY": "directa", "ANALYTICS_API_KEY": "alias"},
            "/ruta/inexistente",
        )
        self.assertEqual(value, "directa")

    def test_alias_from_process_environment_is_supported(self):
        value = resolve_api_key(
            {"ANALYTICS_API_KEY": "compartida"},
            "/ruta/inexistente",
        )
        self.assertEqual(value, "compartida")

    def test_reads_only_the_shared_key_contract_from_api_env(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            api_env = Path(temp_dir) / ".env"
            api_env.write_text(
                'JWT_SECRET=no-se-usa\n'
                'ANALYTICS_API_KEY="clave con # y espacios"\n',
                encoding="utf-8",
            )
            value = resolve_api_key({}, api_env)

        self.assertEqual(value, "clave con # y espacios")

    def test_does_not_reuse_generic_api_key_from_api_env(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            api_env = Path(temp_dir) / ".env"
            api_env.write_text("API_KEY=no-es-el-contrato-compartido\n", encoding="utf-8")
            self.assertIsNone(resolve_api_key({}, api_env))

    def test_missing_configuration_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / "missing.env"
            self.assertIsNone(resolve_api_key({}, missing))

    def test_dedicated_env_precedes_shared_root_env(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root_env = Path(temp_dir) / "root.env"
            analytics_env = Path(temp_dir) / "analytics.env"
            root_env.write_text(
                "DB_NAME=asistencia\nAPI_KEY=raiz\n",
                encoding="utf-8",
            )
            analytics_env.write_text(
                "API_KEY=dedicada\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {}, clear=True):
                load_runtime_environment(root_env, analytics_env)
                self.assertEqual(os.environ["API_KEY"], "dedicada")
                self.assertEqual(os.environ["DB_NAME"], "asistencia")

    def test_process_environment_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root_env = Path(temp_dir) / "root.env"
            analytics_env = Path(temp_dir) / "analytics.env"
            root_env.write_text("API_KEY=raiz\n", encoding="utf-8")
            analytics_env.write_text("API_KEY=archivo\n", encoding="utf-8")
            with patch.dict(os.environ, {"API_KEY": "proceso"}, clear=True):
                load_runtime_environment(root_env, analytics_env)
                self.assertEqual(os.environ["API_KEY"], "proceso")


if __name__ == "__main__":
    unittest.main()
