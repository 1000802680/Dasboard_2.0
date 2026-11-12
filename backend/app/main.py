from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import check_database, engine, get_session


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await engine.dispose()


settings = get_settings()
app = FastAPI(title="Plataforma Empresarial API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/api/health")
async def health(session: AsyncSession = Depends(get_session)) -> dict[str, str]:
    try:
        await check_database(session)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="No se pudo conectar con PostgreSQL.") from exc
    return {"status": "ok", "database": "connected"}


@app.get("/api/roles")
async def list_roles(session: AsyncSession = Depends(get_session)) -> list[dict[str, object]]:
    try:
        result = await session.execute(
            text("SELECT id, nombre, descripcion FROM app.roles ORDER BY id")
        )
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="No se pudieron consultar los roles.") from exc
    return [dict(row) for row in result.mappings().all()]

