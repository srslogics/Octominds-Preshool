import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .auth import CurrentUser, Role, get_current_user
from .config import Settings, get_settings
from .inventory.router import router as inventory_router
from .school.router import router as school_router
from .parents.router import router as parents_router
from .parents.gallery import router as gallery_router
from .teachers.router import router as teacher_router
from .turso.accounts import router as auth_router
from .turso.db import initialize, ready

settings = get_settings()
logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("octominds.api")

@asynccontextmanager
async def lifespan(app):
    # A fresh cloud database still requires explicit provisioning.
    await run_in_threadpool(initialize, settings, bootstrap=not settings.turso_database_url)
    yield


app = FastAPI(lifespan=lifespan, title=settings.app_name, version="0.2.0", docs_url="/docs" if settings.environment != "production" else None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID", "X-Photo-Caption"],
)
app.include_router(inventory_router)
app.include_router(school_router)
app.include_router(parents_router)
app.include_router(gallery_router)
app.include_router(teacher_router)
app.include_router(auth_router)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    logger.info(
        "request_complete request_id=%s method=%s path=%s status=%s duration_ms=%.2f",
        request_id,
        request.method,
        request.url.path,
        response.status_code,
        (time.perf_counter() - started) * 1000,
    )
    return response


class HealthResponse(BaseModel):
    status: str
    environment: str
    version: str


class SessionResponse(BaseModel):
    id: str
    email: str
    phone: str | None
    role: Role
    branch_id: str | None
    full_name: str | None
    branch_name: str | None
    role_label: str
    branch_roles: dict[str, str] | None = None


@app.get("/health", response_model=HealthResponse, tags=["system"])
def health(config: Annotated[Settings, Depends(get_settings)]) -> HealthResponse:
    return HealthResponse(status="ok", environment=config.environment, version="0.2.0")


@app.get("/ready", tags=["system"])
def readiness(config: Annotated[Settings, Depends(get_settings)]) -> Response:
    """Check connectivity and the application schema."""
    database_ready = ready(config)
    return Response(content=json.dumps({'status': 'ready' if database_ready else 'unavailable'}),
                    status_code=200 if database_ready else 503, media_type='application/json',
                    headers={'Cache-Control': 'no-store'})


@app.get("/api/v1/session", response_model=SessionResponse, tags=["authentication"])
def session(user: Annotated[CurrentUser, Depends(get_current_user)]) -> SessionResponse:
    return SessionResponse(**user.session_details())


@app.get("/config.js", include_in_schema=False)
def frontend_config(config: Annotated[Settings, Depends(get_settings)]) -> Response:
    """Expose only browser-safe runtime configuration."""
    payload = "window.OCTOMINDS_CONFIG = Object.freeze({apiBaseUrl: window.location.origin});\n"
    return Response(
        content=payload,
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )


frontend_directory = Path(__file__).resolve().parents[1] / "public"

# Public routes are independent of where each app's files live on disk.
app_urls = {"inventory": "/", "school": "/school", "parents": "/parents", "teachers": "/teachers"}
html_pages = {
    url: frontend_directory / "apps" / app_name / "index.html"
    for app_name, url in app_urls.items()
}
legacy_pages = {
    "/index": "/",
    "/index.html": "/",
    "/inventory": "/",
    "/inventory/": "/",
    "/school/": "/school",
    "/school.html": "/school",
    "/parents/": "/parents",
    "/parents.html": "/parents",
    "/teachers/": "/teachers",
    "/teachers.html": "/teachers",
}
for app_name, url in app_urls.items():
    app_path = f"/apps/{app_name}"
    for suffix in ("", "/", "/index.html"):
        legacy_pages[app_path + suffix] = url

# Older cached app pages may still request the original asset URLs.
legacy_assets = {
    "inventory": ("app.js", "pages.js", "operations.css", "premium.css",
                  "routes.css", "styles.css", "workspace.css"),
    "school": ("school.css", "school.js"),
    "parents": ("parents.css", "parents.js", "parents-preview.js",
                "parents-gallery.js", "parents-gallery-preview.js"),
}
for app_name, filenames in legacy_assets.items():
    for filename in filenames:
        legacy_pages[f"/{filename}"] = f"/apps/{app_name}/{filename}"


@app.middleware("http")
async def clean_page_urls(request: Request, call_next):
    path = request.url.path
    if request.method in {"GET", "HEAD"}:
        if path in legacy_pages:
            target = legacy_pages[path]
            if request.url.query:
                target += "?" + request.url.query
            return RedirectResponse(target, status_code=308)
        if path in html_pages:
            return FileResponse(html_pages[path], headers={"Cache-Control": "no-cache"})
    return await call_next(request)


# Keep this mount last so API and health routes always take precedence.
app.mount("/", StaticFiles(directory=frontend_directory, html=True), name="frontend")
