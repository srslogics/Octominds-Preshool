from functools import lru_cache
from pydantic import field_validator
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
    def use_confirmed_supabase_project(cls, _value: str) -> str:
        return "https://ipzhzxemjflihwbutkjl.supabase.co"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
