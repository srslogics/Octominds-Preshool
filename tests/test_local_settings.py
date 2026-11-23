import unittest
from pydantic import ValidationError
from api.config import Settings


class TursoSettings(unittest.TestCase):
    def test_development_can_use_local_sqlite(self):
        self.assertFalse(Settings(_env_file=None).turso_database_url)

    def test_production_requires_cloud_configuration(self):
        with self.assertRaises(ValidationError):
            Settings(_env_file=None, environment='production')
        with self.assertRaises(ValidationError):
            Settings(_env_file=None, environment='production', turso_database_url='libsql://project.turso.io')
        settings = Settings(_env_file=None, environment='production',
                            turso_database_url='libsql://project.turso.io', turso_auth_token='hidden')
        self.assertNotIn('hidden', str(settings))

    def test_cloud_url_has_no_embedded_credentials_or_path(self):
        for url in ['https://turso.io.evil.example', 'https://user@project.turso.io', 'https://project.turso.io/path']:
            with self.assertRaises(ValidationError):
                Settings(_env_file=None, turso_database_url=url, turso_auth_token='test')
