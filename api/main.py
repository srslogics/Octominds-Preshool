import logging
import time
import uuid
from typing import Annotated

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .auth import CurrentUser, Role, get_current_user, require_roles
from .config import Settings, get_settings

settings = get_settings()
logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("octominds.api")

app = FastAPI(title=settings.app_name, version="0.1.0", docs_url="/docs" if settings.environment != "production" else None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
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


@app.get("/health", response_model=HealthResponse, tags=["system"])
def health(config: Annotated[Settings, Depends(get_settings)]) -> HealthResponse:
    return HealthResponse(status="ok", environment=config.environment, version="0.1.0")


@app.get("/api/v1/session", response_model=SessionResponse, tags=["authentication"])
def session(user: Annotated[CurrentUser, Depends(get_current_user)]) -> SessionResponse:
    return SessionResponse(**user.__dict__, role_label=user.role_label)


@app.get("/api/v1/admin/access-check", tags=["authorization"])
def admin_access(
    user: Annotated[
        CurrentUser,
        Depends(require_roles(Role.SUPER_ADMIN, Role.MANAGEMENT, Role.BRANCH_ADMIN)),
    ],
):
    return {"allowed": True, "role": user.role, "branch_id": user.branch_id}
