# Backend FastAPI local

Este backend es independiente de Cloudflare Pages y no modifica ni migra datos. En esta primera etapa solo permite comprobar la conexión PostgreSQL y consultar los roles existentes.

## Requisitos

- Python 3.11 o posterior.
- PostgreSQL iniciado en el computador.
- La base `PLATAFORMA_EMPRESARIAL` y el esquema `app` ya creados.

## Inicio en Windows PowerShell

Desde la carpeta `backend`:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
notepad .env
```

En `.env`, sustituye `CAMBIAR_CLAVE` por la contraseña del usuario PostgreSQL local. No subas ese archivo a GitHub.

Inicia la API:

```powershell
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Abre `http://127.0.0.1:8000/api/health` para verificar la conexión y `http://127.0.0.1:8000/api/roles` para consultar los cuatro roles. La documentación interactiva está en `http://127.0.0.1:8000/docs`.

## Cuando la base pase a un servidor

Se cambia `DATABASE_URL` por la dirección segura del servidor; el código de conexión se conserva. Para uso en producción se configurarán TLS, lista de orígenes CORS del dominio real y credenciales administradas como secretos.

