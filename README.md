# Dashboard COL-FT: migración a GitHub + Cloudflare Pages + SeaTable

Este directorio prepara una migración gradual de Google Apps Script a Cloudflare Pages Functions. `Codigo.gs` queda como respaldo de la versión actual y **no se ejecuta en Cloudflare**.

## Qué está conectado en esta primera etapa

- Se conserva una copia de la interfaz en `public/index.html`.
- `public/gas-bridge.js` conecta el transporte de la interfaz a `/api/legacy` y `/api/auth`.
- `functions/_lib/seatable.js` descubre dinámicamente todas las tablas del base (incluidas las pestañas nuevas), lee filas paginadas y procesa cada fila al recibirla para reducir memoria; prepara el mapa de encabezados una vez por tabla y elimina duplicados conservando la fila con la fecha de etapa más reciente (`_mtime` como respaldo).
- `/api/legacy` atiende lectura del dashboard, recarga, checksum, análisis, estados y búsqueda por número de OPA.
- `/api/health` indica si faltan variables de configuración.
- El login nuevo usa SeaTable para usuarios y auditoría; los registros de OPA permanecen en modo consulta y la búsqueda de OPA exige una sesión válida.
- Los filtros son dependientes: Marca (tabla) → Proyecto → Tipo de producto → Número de OPA. Las tablas `USUARIOS` y `HISTORIAL_AUDITORIA` se excluyen del dashboard.
- El dashboard revisa los metadatos de las pestañas cada 60 segundos. Si detecta una pestaña nueva, la incorpora y vuelve a leer la base. Los registros en memoria duran hasta 5 minutos; “Actualizar datos” fuerza una lectura nueva de SeaTable de inmediato.

## Pendiente antes de usarlo con el equipo

Las capturas muestran varias tablas dentro de la base (BLUEY, CABALLERO DEL ZODIACO, DISNEY CO, etc.), por eso la lectura ahora descubre las tablas del base y procesa cada una. La API oficial de SeaTable incluye el listado de tablas en Metadata y filas paginadas por tabla.

La autenticación se migró a las tablas `USUARIOS` y `HISTORIAL_AUDITORIA` de SeaTable. No se importan los usuarios anteriores de Google Apps Script: el primer usuario nuevo se registra como administrador usando la clave de bootstrap; los siguientes se crean como usuarios estándar. El permiso de edición de OPAs continúa deshabilitado en Cloudflare hasta migrar las escrituras de negocio.

También falta confirmar cómo se trata un mismo número de OPA repetido en distintos proyectos o subOPAs. El código actual agrupa por proyecto + número de OPA y escoge la fila con la fecha de etapa más nueva; si no hay fechas, usa `_mtime` de SeaTable como respaldo. Esa regla debe compararse con la base real antes de tomar los conteos como oficiales.

## Configuración local

1. Instala Node.js LTS y Wrangler: `npm install`.
2. Copia `.env.example` a `.dev.vars` y completa URL, API token, UUID de base y, si hace falta, `SEATABLE_COLUMN_MAP`. Por defecto, el código descubre todas las tablas.
3. Ejecuta `npx wrangler pages dev public`.
4. Comprueba `http://localhost:8788/api/health` y después `/api/legacy` desde la interfaz.

`SEATABLE_COLUMN_MAP` debe ser JSON con clave interna del dashboard y nombre exacto en SeaTable. Ejemplo: `{"P":"PROYECTO","O":"NUMERO DE OPA","E":"ESTADO PLATAFORMA","F3":"PRE-PRODUCCION ENVIADA"}`. Para bases con muchas columnas, `SEATABLE_VIEW_NAME` puede apuntar a una vista de SeaTable que muestre solo las columnas utilizadas; crea esa vista con el mismo nombre en cada tabla incluida.

## Configurar inicio de sesión en SeaTable

Usa la misma base del dashboard: crea allí las tablas `USUARIOS` y `HISTORIAL_AUDITORIA`. La aplicación reutiliza `SEATABLE_BASE_UUID` y `SEATABLE_API_TOKEN` automáticamente si no defines `SEATABLE_AUTH_BASE_UUID` ni `SEATABLE_AUTH_API_TOKEN`. El token existente debe tener permiso de lectura y escritura para crear usuarios. Si el token actual es de solo lectura, cambia su permiso en SeaTable o define un token de escritura para la misma base. Crea las columnas como texto y con estos nombres exactos (los nombres son sensibles a errores tipográficos):

- `USUARIOS`: `ID_USUARIO`, `USERNAME`, `NOMBRE_COMPLETO`, `ROL`, `HASH_PWD`, `SALT`, `FECHA_REGISTRO_ISO`, `ULTIMO_ACCESO_ISO`, `CORREO`, `PERMISOS_JSON`.
- `HISTORIAL_AUDITORIA`: `TIMESTAMP_ISO`, `FECHA_HORA_LOCAL`, `USERNAME`, `ROL`, `TIPO_ACCION`, `DETALLE_JSON`, `OPA_AFECTADA`, `HOJA_AFECTADA`, `FILA_AFECTADA`.

En Cloudflare configura `AUTH_SESSION_SECRET` como secreto aleatorio largo y `AUTH_BOOTSTRAP_KEY` como secreto de un solo uso para crear el primer administrador. No necesitas configurar las variables `SEATABLE_AUTH_*` cuando usuarios y dashboard están en la misma base; si las defines, deben apuntar a esa misma base. La primera cuenta se registra desde “Crear usuario” con la clave bootstrap; después de crearla, borra `AUTH_BOOTSTRAP_KEY` y vuelve a desplegar. La sesión dura 12 horas.

## Publicación en Cloudflare

1. Sube el código a un repositorio **privado** de GitHub. No incluyas `.dev.vars` ni credenciales.
2. En Cloudflare Pages, crea un proyecto conectado al repositorio y usa `public` como directorio de salida.
3. Configura `SEATABLE_SERVER_URL`, `SEATABLE_API_TOKEN`, `SEATABLE_BASE_UUID`, `AUTH_SESSION_SECRET` y `AUTH_BOOTSTRAP_KEY` en Settings → Variables and Secrets para el mismo entorno al que despliegas; marca los tokens y claves como **Secret**. `SEATABLE_AUTH_BASE_UUID` y `SEATABLE_AUTH_API_TOKEN` son opcionales. `SEATABLE_VIEW_NAME` también es opcional; si está configurado, debe existir en todas las tablas que se consultan. No configures una lista fija de tablas: el sistema las detecta automáticamente.
4. Publica primero en una URL de vista previa y compara conteos contra SeaTable antes de compartir el enlace final.

El dashboard consulta SeaTable cada 30 segundos para reflejar cambios en filas existentes y pestañas nuevas. El botón “Actualizar datos” fuerza una lectura inmediata. Las rutas de Functions cuentan contra el cupo diario gratuito de Workers; sirve solo las rutas API a través de Functions y mantiene los archivos estáticos fuera de sus invocaciones cuando se genere `_routes.json`.

