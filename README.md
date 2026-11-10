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
- El dashboard conserva un snapshot compartido en la caché de Cloudflare. Una escritura marca ese snapshot como vencido sin borrarlo; el sondeo devuelve la copia utilizable inmediatamente y solicita una reconstrucción en segundo plano. Así los usuarios de la misma región de Cloudflare no esperan el escaneo completo de miles de filas. La caché de Cloudflare es por centro de datos, no un almacén global; una región sin snapshot todavía necesita una lectura inicial de SeaTable.
- La sesión firmada valida los permisos contra `USUARIOS` con una caché breve de 20 segundos por instancia, y la auditoría de ediciones se programa en segundo plano con `waitUntil` en Cloudflare para no retrasar la confirmación del guardado.
- Crear una OPA agrega el registro a la copia local sin forzar una descarga completa de todas las hojas después de guardar.
- El Dashboard incluye una mini IA para preguntas en lenguaje natural. Cloudflare Workers AI interpreta la pregunta y devuelve un plan limitado; el navegador aplica ese plan a los datos cargados y a los filtros activos. Las filas no se envían al modelo.

## Pendiente antes de usarlo con el equipo

Las capturas muestran varias tablas dentro de la base (BLUEY, CABALLERO DEL ZODIACO, DISNEY CO, etc.), por eso la lectura ahora descubre las tablas del base y procesa cada una. La API oficial de SeaTable incluye el listado de tablas en Metadata y filas paginadas por tabla.

La autenticación se migró a las tablas `USUARIOS` y `HISTORIAL_AUDITORIA` de SeaTable. No se importan los usuarios anteriores de Google Apps Script: el primer usuario nuevo se registra como administrador usando la clave de bootstrap; los siguientes se crean como usuarios estándar. Cada usuario elige Primavera o Conceptos Gráficos; esa opción se guarda dentro de `PERMISOS_JSON`, por lo que no requiere agregar una columna a SeaTable. El permiso de edición de OPAs continúa deshabilitado en Cloudflare hasta migrar las escrituras de negocio.

También falta confirmar cómo se trata un mismo número de OPA repetido en distintos proyectos o subOPAs. El código actual agrupa por proyecto + número de OPA y escoge la fila con la fecha de etapa más nueva; si no hay fechas, usa `_mtime` de SeaTable como respaldo. Esa regla debe compararse con la base real antes de tomar los conteos como oficiales.

## Configuración local

1. Instala Node.js LTS y Wrangler: `npm install`.
2. Copia `.env.example` a `.dev.vars` y completa URL, API token, UUID de base y, si hace falta, `SEATABLE_COLUMN_MAP`. Por defecto, el código descubre todas las tablas.
3. Ejecuta `npx wrangler pages dev public`.
4. Comprueba `http://localhost:8788/api/health` y después `/api/legacy` desde la interfaz.

## Mini IA del Dashboard

La mini IA requiere que el proyecto de Cloudflare Pages tenga un binding de Workers AI llamado `AI`. Ya está declarado en `wrangler.toml`; si Cloudflare no lo toma desde ese archivo, agrégalo en Settings → Functions → Workers AI, con el nombre `AI`, y vuelve a desplegar. Las preguntas requieren iniciar sesión. El modelo solo recibe la pregunta actual y hasta cuatro preguntas anteriores para entender seguimientos; el cálculo se hace localmente con los datos ya cargados. Las respuestas basadas en “hoy” usan la fecha real de creación de SeaTable (`_ctime`); si faltan esas fechas, la interfaz advierte que el total puede ser parcial.

El código de la página publicado por Pages está en `public/index.html` porque `wrangler.toml` define `pages_build_output_dir = "./public"`. Editar el `Index.html` de la raíz no cambia la página publicada.

`SEATABLE_COLUMN_MAP` debe ser JSON con clave interna del dashboard y nombre exacto en SeaTable. Ejemplo: `{"P":"PROYECTO","O":"NUMERO DE OPA","E":"ESTADO PLATAFORMA","F3":"PRE-PRODUCCION ENVIADA"}`. Para bases con muchas columnas, `SEATABLE_VIEW_NAME` puede apuntar a una vista de SeaTable que muestre solo las columnas utilizadas; crea esa vista con el mismo nombre en cada tabla incluida.

## Configurar inicio de sesión en SeaTable

Usa la misma base del dashboard: crea allí las tablas `USUARIOS` y `HISTORIAL_AUDITORIA`. La aplicación reutiliza `SEATABLE_BASE_UUID` y `SEATABLE_API_TOKEN` automáticamente si no defines `SEATABLE_AUTH_BASE_UUID` ni `SEATABLE_AUTH_API_TOKEN`. El token existente debe tener permiso de lectura y escritura para crear usuarios. Si el token actual es de solo lectura, cambia su permiso en SeaTable o define un token de escritura para la misma base. Crea las columnas como texto y con estos nombres exactos (los nombres son sensibles a errores tipográficos):

- `USUARIOS`: `ID_USUARIO`, `USERNAME`, `NOMBRE_COMPLETO`, `ROL`, `HASH_PWD`, `SALT`, `FECHA_REGISTRO_ISO`, `ULTIMO_ACCESO_ISO`, `CORREO`, `PERMISOS_JSON`.
- `HISTORIAL_AUDITORIA`: `TIMESTAMP_ISO`, `FECHA_HORA_LOCAL`, `USERNAME`, `ROL`, `TIPO_ACCION`, `DETALLE_JSON`, `OPA_AFECTADA`, `HOJA_AFECTADA`, `FILA_AFECTADA`.

En Cloudflare configura `AUTH_SESSION_SECRET` como secreto aleatorio largo y `AUTH_BOOTSTRAP_KEY` como secreto de un solo uso para crear el primer administrador. No necesitas configurar las variables `SEATABLE_AUTH_*` cuando usuarios y dashboard están en la misma base; si las defines, deben apuntar a esa misma base. La clave inicial solo se muestra en un bloque independiente mientras todavía no exista un administrador. Después de crear la cuenta, borra `AUTH_BOOTSTRAP_KEY` y vuelve a desplegar. Cada dispositivo requiere su propio inicio de sesión; los tokens de sesión se guardan en `sessionStorage` y duran 12 horas. “¿Olvidaste tu contraseña?” informa al usuario que debe pedir al administrador un restablecimiento. En el panel de usuarios el administrador puede establecer una contraseña temporal nueva; la contraseña anterior no se puede consultar y el restablecimiento cierra las sesiones de esa cuenta. Al desplegar esta versión, todos tendrán que iniciar sesión una vez más porque los tokens anteriores no incluían la versión de contraseña.

## Publicación en Cloudflare

1. Sube el código a un repositorio **privado** de GitHub. No incluyas `.dev.vars` ni credenciales.
2. En Cloudflare Pages, conecta el repositorio, deja el comando de compilación vacío para este HTML estático y establece `public` como directorio de salida. Pages debe detectar y publicar `functions/api/*` desde la carpeta `functions` de la raíz. No uses `npx wrangler deploy`: ese comando publica un Worker, no las Pages Functions de este proyecto. Para un despliegue manual usa `npm run deploy` (`wrangler pages deploy public --project-name=dasboard-2-0`).
3. Configura `SEATABLE_SERVER_URL`, `SEATABLE_API_TOKEN`, `SEATABLE_BASE_UUID`, `AUTH_SESSION_SECRET` y `AUTH_BOOTSTRAP_KEY` en Settings → Variables and Secrets para el mismo entorno al que despliegas; marca los tokens y claves como **Secret**. `SEATABLE_AUTH_BASE_UUID` y `SEATABLE_AUTH_API_TOKEN` son opcionales. `SEATABLE_VIEW_NAME` también es opcional; si está configurado, debe existir en todas las tablas que se consultan. No configures una lista fija de tablas: el sistema las detecta automáticamente.
4. Publica primero en una URL de vista previa y compara conteos contra SeaTable antes de compartir el enlace final.

El dashboard revisa SeaTable cada 15 segundos. Si el snapshot compartido ya tiene más de 60 segundos o una escritura lo marcó vencido, el endpoint de checksum devuelve los datos disponibles y programa una lectura nueva con `waitUntil`; los clientes cargan los datos nuevos en el siguiente sondeo al cambiar el ETag. El botón “Actualizar datos” fuerza una lectura inmediata. Las rutas de Functions cuentan contra el cupo diario gratuito de Workers; sirve solo las rutas API a través de Functions y mantiene los archivos estáticos fuera de sus invocaciones cuando se genere `_routes.json`.

