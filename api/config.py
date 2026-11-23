from functools import lru_cache
from urllib.parse import urlparse

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = 'OctoMinds API'
    environment: str = 'development'
    frontend_origin: str = 'http://127.0.0.1:8000'
    turso_database_url: str = ''
    turso_auth_token: SecretStr = SecretStr('')
    sqlite_path: str = '.local/octominds.db'
    resend_api_key: SecretStr = SecretStr('')
    mail_from: str = ''
    log_level: str = 'INFO'

    @model_validator(mode='after')
    def validate_backend(self):
        if self.turso_database_url:
            url = urlparse(self.turso_database_url)
            if (url.scheme not in {'libsql', 'https'} or not url.hostname or
                    not url.hostname.endswith('.turso.io') or url.username or url.password or
                    url.path not in {'', '/'} or url.query or url.fragment):
                raise ValueError('TURSO_DATABASE_URL must be the database URL from Turso')
            if not self.turso_auth_token.get_secret_value():
                raise ValueError('TURSO_AUTH_TOKEN is required for Turso Cloud')
        elif self.environment == 'production':
            raise ValueError('TURSO_DATABASE_URL is required in production')
        if self.environment == 'production' and self.resend_api_key.get_secret_value():
            url = urlparse(self.frontend_origin)
            if url.scheme != 'https' or not url.hostname or url.path not in {'', '/'} or url.query or url.fragment:
                raise ValueError('Set FRONTEND_ORIGIN to the public HTTPS service origin for account email')
        return self

    model_config = SettingsConfigDict(env_file='.env', extra='ignore')


@lru_cache
def get_settings():
    return Settings()
