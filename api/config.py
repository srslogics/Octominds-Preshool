from functools import lru_cache
from urllib.parse import urlparse
from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "OctoMinds API"
    environment: str = "development"
    frontend_origin: str = "http://localhost:4173"
    supabase_url: str = "https://ipzhzxemjflihwbutkjl.supabase.co"
    supabase_anon_key: str = ""
    supabase_jwt_secret: str = ""
    database_url: str = ""
    log_level: str = "INFO"

    @field_validator("supabase_url", mode="before")
    @classmethod
    def normalize_supabase_url(cls, value: str) -> str:
        normalized = str(value or "").strip().rstrip("/")
        return normalized

    @model_validator(mode="after")
    def require_production_auth_configuration(self):
        endpoint = urlparse(self.supabase_url)
        hosted = (endpoint.scheme == "https" and (endpoint.hostname or "").endswith(".supabase.co")
                  and endpoint.path in {"", "/"} and not endpoint.query and not endpoint.fragment
                  and not endpoint.username and not endpoint.password and endpoint.port in {None, 443})
        local = (self.environment != "production" and endpoint.scheme in {"http", "https"}
                 and endpoint.hostname in {"localhost", "127.0.0.1", "::1"}
                 and endpoint.path in {"", "/"} and not endpoint.query and not endpoint.fragment
                 and not endpoint.username and not endpoint.password)
        if not hosted and not local:
            raise ValueError("SUPABASE_URL must be a Supabase project URL, or a loopback URL outside production")
        if self.environment == "production" and not self.supabase_anon_key.strip():
            raise ValueError("SUPABASE_ANON_KEY is required in production")
        return self

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
