from functools import lru_cache
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
        if not normalized.startswith("https://") or not normalized.endswith(".supabase.co"):
            raise ValueError("SUPABASE_URL must be a valid Supabase project URL")
        return normalized

    @model_validator(mode="after")
    def require_production_auth_configuration(self):
        if self.environment == "production" and not self.supabase_anon_key.strip():
            raise ValueError("SUPABASE_ANON_KEY is required in production")
        return self

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
