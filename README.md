# Dashboard COL-FT: migración a GitHub + Cloudflare Pages + SeaTable

Este directorio prepara una migración gradual de Google Apps Script a Cloudflare Pages Functions. `Codigo.gs` queda como respaldo de la versión actual y **no se ejecuta en Cloudflare**.

## Qué está conectado en esta primera etapa

- Se conserva una copia de la interfaz en `public/index.html`.
- `public/gas-bridge.js` reemplaza el transporte `google.script.run` por solicitudes a `/api/legacy`.
- `functions/_lib/seatable.js` obtiene un token de base a partir del API token, descubre las tablas del base, lee todas las filas paginadas, mapea columnas y elimina duplicados de OPA conservando la fila con la fecha de etapa más reciente (usa `_mtime` como respaldo).
- `/api/legacy` atiende lectura del dashboard, recarga, checksum, análisis, estados y búsqueda por número de OPA.
- `/api/health` indica si faltan variables de configuración.
- La copia de Cloudflare queda en modo consulta: oculta cuenta/login y no presenta acciones de edición que todavía dependen de Apps Script.
- Los filtros son dependientes: Marca (tabla) → Proyecto → Tipo de producto → Número de OPA. Las tablas `USUARIOS` y `HISTORIAL_AUDITORIA` se excluyen del dashboard.
- El dashboard vuelve a consultar automáticamente cada 60 segundos; “Actualizar datos” fuerza una lectura nueva. La función conserva los resultados en memoria por 30 segundos para reducir llamadas repetidas a SeaTable.

## Pendiente antes de usarlo con el equipo

Las capturas muestran varias tablas dentro de la base (BLUEY, CABALLERO DEL ZODIACO, DISNEY CO, etc.), por eso la lectura ahora descubre las tablas del base y procesa cada una. La API oficial de SeaTable incluye el listado de tablas en Metadata y filas paginadas por tabla.

La aplicación original también contiene registro e inicio de sesión, permisos de administrador, auditoría y edición de estados/campos. Esas funciones todavía usan hojas de Google y no se deben dar por migradas. El adaptador responde `501` para ellas deliberadamente; por eso la versión Cloudflare oculta login/edición y sirve solo para consulta. **No uses esta versión si necesitas editar datos o administrar usuarios** hasta completar esas rutas y acordar la política de acceso.

También falta confirmar cómo se trata un mismo número de OPA repetido en distintos proyectos o subOPAs. El código actual agrupa por proyecto + número de OPA y escoge la fila con la fecha de etapa más nueva; si no hay fechas, usa `_mtime` de SeaTable como respaldo. Esa regla debe compararse con la base real antes de tomar los conteos como oficiales.

## Configuración local

1. Instala Node.js LTS y Wrangler: `npm install`.
2. Copia `.env.example` a `.dev.vars` y completa URL, API token, UUID de base y, si hace falta, `SEATABLE_COLUMN_MAP`. Por defecto, el código descubre todas las tablas.
3. Ejecuta `npx wrangler pages dev public`.
4. Comprueba `http://localhost:8788/api/health` y después `/api/legacy` desde la interfaz.

`SEATABLE_COLUMN_MAP` debe ser JSON con clave interna del dashboard y nombre exacto en SeaTable. Ejemplo: `{"P":"PROYECTO","O":"NUMERO DE OPA","E":"ESTADO PLATAFORMA","F3":"PRE-PRODUCCION ENVIADA"}`.

## Publicación en Cloudflare

1. Sube el código a un repositorio **privado** de GitHub. No incluyas `.dev.vars` ni credenciales.
2. En Cloudflare Pages, crea un proyecto conectado al repositorio y usa `public` como directorio de salida.
3. Configura `SEATABLE_SERVER_URL`, `SEATABLE_API_TOKEN`, `SEATABLE_BASE_UUID` y `SEATABLE_COLUMN_MAP` en Settings → Variables and Secrets; marca el API token como **Secret**. `SEATABLE_TABLE_NAMES` es opcional; vacío significa descubrir todas las tablas del base.
4. Publica primero en una URL de vista previa y compara conteos contra SeaTable antes de compartir el enlace final.

Las rutas de Functions cuentan contra el cupo diario gratuito de Workers; sirve solo las rutas API a través de Functions y mantiene los archivos estáticos fuera de sus invocaciones cuando se genere `_routes.json`.

