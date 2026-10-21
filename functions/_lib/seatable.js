const DEFAULT_COLUMNS = {
  P: "PROYECTO",
  T: "TIPO DE PRODUCTO",
  TE: "TIPO DE PRODUCTO ESPECIFICO",
  M: "MARCA",
  TR: "TERRITORIO",
  LF: "LINK O FOTO PRODUCTO",
  PO: "PORTAFOLIO",
  B2B: "ITEM / SKU B2B",
  B2C: "ITEM / SKU B2C",
  D: "DESCRIPCIÓN DEL PRODUCTO ERP",
  NP: "NOMBRE DE PRODUCTO EN OPA",
  O: "NUMERO DE OPA",
  SO: "SUBOPA",
  PJ: "PERSONAJE",
  E: "ESTADO PLATAFORMA",
  F: "FECHA",
  F1: "CONCEPTO ENVIADO",
  F2: "CONCEPTO APROBADO",
  F3: "PRE-PRODUCCION ENVIADA",
  F4: "PRE-PRODUCCION APROBADA",
  F5: "FOTOS DE PRODUCCION ENVIADA",
  F6: "FOTOS DE PRODUCCION APROBADA",
  F7: "MUESTRAS FINALES ENVIADAS",
  F8: "APROBADA / CERRADA",
  FM: "FECHA ENVIO DE MUESTRAS",
  MR: "CANTIDAD MUESTRAS RECIBIDAS",
  ME: "CANTIDAD DE MUESTRAS ENVIADAS",
  GE: "ENLACE GUÍA DE ENVÍO",
};

const EMPTY_OPA = new Set(["", "N/A", "NA", "N.A.", "-", "SIN OPA", "NINGUNO", "NINGUNA"]);

function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function getColumnMap(env) {
  let overrides = {};
  if (env.SEATABLE_COLUMN_MAP) {
    try { overrides = JSON.parse(env.SEATABLE_COLUMN_MAP); }
    catch { throw new Error("SEATABLE_COLUMN_MAP no es un JSON válido."); }
  }
  return { ...DEFAULT_COLUMNS, ...overrides };
}

export function getDashboardColumnName(env, internalKey) {
  const columnName = getColumnMap(env)[String(internalKey || "")];
  if (!columnName) throw new Error(`El campo ${internalKey} no está configurado en SeaTable.`);
  return columnName;
}

async function getBaseToken(env, apiToken = env.SEATABLE_API_TOKEN) {
  const now = Date.now();
  const cached = globalThis.__seatableToken;
  if (cached?.key === apiToken && cached.expiresAt > now + 60_000) return cached.value;

  const response = await fetch(`${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api/v2.1/dtable/app-access-token/`, {
    headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`SeaTable no entregó un token de base (HTTP ${response.status}). Revisa URL y API token.`);
  }
  globalThis.__seatableToken = { key: apiToken, value: body.access_token, workspaceId: body.workspace_id || "", expiresAt: now + 2 * 24 * 60 * 60 * 1000 };
  return body.access_token;
}

export async function getDashboardWorkspaceId(env, apiToken = env.SEATABLE_API_TOKEN) {
  const cached = globalThis.__seatableToken;
  if (cached?.key === apiToken && cached.workspaceId) return String(cached.workspaceId);
  const response = await fetch(`${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api/v2.1/dtable/app-access-token/`, {
    headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.workspace_id || !body.access_token) throw new Error(`SeaTable no devolvió el identificador del espacio de trabajo (HTTP ${response.status}).`);
  globalThis.__seatableToken = {
    key: apiToken,
    value: body.access_token,
    workspaceId: body.workspace_id,
    expiresAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
  };
  return String(body.workspace_id);
}

function assertConfig(env) {
  const missing = ["SEATABLE_SERVER_URL", "SEATABLE_API_TOKEN", "SEATABLE_BASE_UUID"]
    .filter((key) => !env[key]);
  if (missing.length) throw new Error(`Falta configurar: ${missing.join(", ")}.`);
}

export async function discoverTableNames(env, token = null) {
  const server = env.SEATABLE_SERVER_URL.replace(/\/$/, "");
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  token = token || await getBaseToken(env);
  const metadataUrl = `${server}/api-gateway/api/v2/dtables/${baseId}/metadata/`;
  const metadataResponse = await fetch(metadataUrl, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const metadataBody = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok) throw new Error(`No se pudo leer la lista de pestañas de SeaTable (HTTP ${metadataResponse.status}).`);
  const tables = metadataBody.metadata?.tables || metadataBody.tables || [];
  const names = tables.map((table) => table.name).filter(Boolean);
  if (!names.length) throw new Error("SeaTable no devolvió pestañas. Verifica el UUID y los permisos del token.");
  const excludedTables = new Set([
    "USUARIOS",
    "HISTORIAL_AUDITORIA",
    "HISTORIAL DE AUTORIA",
  ].map(normalizeHeader));
  return [...new Set(names)].filter((name) => !excludedTables.has(normalizeHeader(name)));
}

async function forEachSeaTableRow(env, onRow, knownTableNames = null) {
  assertConfig(env);
  const token = await getBaseToken(env);
  const server = env.SEATABLE_SERVER_URL.replace(/\/$/, "");
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  const tableNames = knownTableNames || await discoverTableNames(env, token);
  if (!tableNames.length) throw new Error("No se encontraron tablas en la base SeaTable. Revisa permisos y configuración.");

  const pageSize = 1000;
  // Las hojas son independientes; leerlas en serie hace que una base con muchas
  // marcas tarde decenas de segundos. Limitamos la concurrencia para acelerar
  // la carga sin disparar cientos de solicitudes a SeaTable.
  const maxConcurrentTables = Math.min(4, tableNames.length);
  let nextTableIndex = 0;
  async function readTable(tableName) {
    const tableRows = [];
    for (let start = 0; ; start += pageSize) {
      const url = new URL(`${server}/api-gateway/api/v2/dtables/${baseId}/rows/`);
      url.searchParams.set("table_name", tableName);
      url.searchParams.set("start", String(start));
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("convert_keys", "true");
      if (env.SEATABLE_VIEW_NAME) url.searchParams.set("view_name", env.SEATABLE_VIEW_NAME);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Error leyendo la tabla "${tableName}" de SeaTable (HTTP ${response.status}).`);
      const rows = Array.isArray(body) ? body : (body.rows || body.results || []);
      tableRows.push(...rows);
      if (rows.length < pageSize) break;
      if (start + rows.length >= 100_000) throw new Error("La lectura supera el tope de seguridad de 100.000 filas. Usa vistas o consulta por páginas/filtros.");
    }
    return tableRows;
  }
  for (let start = 0; start < tableNames.length; start += maxConcurrentTables) {
    const batch = tableNames.slice(start, start + maxConcurrentTables);
    const batchRows = await Promise.all(batch.map(readTable));
    // Procesar según el orden original de las pestañas mantiene resultados y ETag estables.
    batchRows.forEach((rows, index) => rows.forEach((row) => onRow(row, batch[index])));
  }
  return tableNames;
}

function getSourceKeyMap(row, columns) {
  const wanted = new Map(Object.entries(columns).map(([internal, external]) => [normalizeHeader(external), internal]));
  const map = [];
  for (const key of Object.keys(row)) {
    const internal = wanted.get(normalizeHeader(key));
    if (internal) map.push([key, internal]);
  }
  return map;
}

function toInternalRecord(row, tableName, sourceKeyMap) {
  const result = { H: tableName || "SeaTable" };
  for (const [sourceKey, internal] of sourceKeyMap) {
    const value = row[sourceKey];
    if (value == null || value === "") continue;
    if (internal === "LF" && Array.isArray(value)) result[internal] = value;
    else if (internal === "MR" || internal === "ME") result[internal] = Number(value) || 0;
    else if (internal === "F" || (internal.length === 2 && internal[0] === "F") || internal === "FM") result[internal] = normalizeDate(value);
    else result[internal] = String(value).trim();
  }
  result._id = row._id || "";
  result._mtime = row._mtime || row._ctime || "";
  if (EMPTY_OPA.has(String(result.O || "").trim().toUpperCase())) result.O = "";
  return result;
}

function normalizeDate(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString().slice(0, 10);
  const text = String(value).trim();
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const spanish = text.toLocaleLowerCase().match(/^(\d{1,2})\s*\/\s*([a-záéíóú]+)\s*\/\s*(\d{2,4})$/i);
  if (spanish) {
    const months = { enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06", julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12" };
    const month = months[spanish[2].normalize("NFD").replace(/[\u0300-\u036f]/g, "")];
    let year = spanish[3];
    if (year.length === 2) year = Number(year) >= 70 ? `19${year}` : `20${year}`;
    if (month) return `${year}-${month}-${spanish[1].padStart(2, "0")}`;
  }
  return text;
}

function deduplicateLatestOPA(records) {
  const latest = new Map();
  const withoutOPA = [];
  for (const record of records) {
    const opa = String(record.O || "").trim();
    if (!opa) { withoutOPA.push(record); continue; }
    const project = String(record.P || "").trim().toLocaleUpperCase();
    const key = `${project}\u0000${opa}`;
    const current = latest.get(key);
    const currentTime = activityTime(current);
    const incomingTime = activityTime(record);
    if (!current || incomingTime >= currentTime) latest.set(key, record);
  }
  return [...latest.values(), ...withoutOPA];
}

function activityTime(record) {
  if (!record) return 0;
  // Fechas normalizadas como YYYY-MM-DD y marcas _mtime son comparables como texto.
  let latestStage = "";
  for (const key of ["F8", "F7", "F6", "F5", "F4", "F3", "F2", "F1", "FM", "F"]) {
    const value = record[key];
    if (value && value > latestStage) latestStage = value;
  }
  return latestStage || record._mtime || "";
}

export async function loadDashboardRecords(env, { forceRefresh = false, tableNames = null } = {}) {
  const cacheKey = [env.SEATABLE_BASE_UUID, env.SEATABLE_VIEW_NAME || "*", env.SEATABLE_COLUMN_MAP || "default"].join("|");
  const now = Date.now();
  const cached = globalThis.__dashboardRowsCache;
  if (!forceRefresh && cached?.key === cacheKey && cached.expiresAt > now) return cached.records;
  if (!forceRefresh && globalThis.__dashboardRowsLoading?.key === cacheKey) return globalThis.__dashboardRowsLoading.promise;

  // Cache API de Cloudflare comparte el resultado entre solicitudes/aislamientos
  // cercanos. Así los usuarios concurrentes no vuelven a leer todas las hojas.
  const sharedCache = !forceRefresh && getSharedDashboardCache(env);
  if (sharedCache) {
    try {
      const shared = await sharedCache.match(dashboardCacheRequest(env));
      if (shared) {
        const snapshot = await shared.json();
        if (Array.isArray(snapshot.records) && Array.isArray(snapshot.tableNames)) {
          globalThis.__dashboardRowsCache = { key: cacheKey, records: snapshot.records, tableNames: snapshot.tableNames, expiresAt: Date.now() + 15_000 };
          return snapshot.records;
        }
      }
    } catch (_) {}
  }

  const promise = (async () => {
    const columnMap = getColumnMap(env);
    const schemaByTable = new Map();
    const latest = new Map();
    const withoutOPA = [];
    let rowCount = 0;
    const detectedTableNames = await forEachSeaTableRow(env, (row, tableName) => {
      rowCount++;
      if (rowCount > 100_000) throw new Error("La lectura supera el tope de seguridad de 100.000 filas. Usa vistas o consulta por páginas/filtros.");
      let sourceKeyMap = schemaByTable.get(tableName);
      if (!sourceKeyMap) {
        sourceKeyMap = getSourceKeyMap(row, columnMap);
        schemaByTable.set(tableName, sourceKeyMap);
      }
      const record = toInternalRecord(row, tableName, sourceKeyMap);
      const opa = String(record.O || "").trim();
      if (!opa) { withoutOPA.push(record); return; }
      const project = String(record.P || "").trim().toLocaleUpperCase();
      const key = `${project}\u0000${opa}`;
      const current = latest.get(key);
      if (!current || activityTime(record) >= activityTime(current)) latest.set(key, record);
    }, tableNames);
    const records = [...latest.values(), ...withoutOPA];
    // Refresca los registros junto con el sondeo del dashboard, para que los
    // cambios en filas existentes no queden ocultos detrás de una caché larga.
    // La acción manual "Actualizar datos" sigue forzando una lectura inmediata.
    globalThis.__dashboardRowsCache = { key: cacheKey, records, tableNames: detectedTableNames, expiresAt: Date.now() + 15_000 };
    if (sharedCache) {
      try {
        await sharedCache.put(dashboardCacheRequest(env), new Response(JSON.stringify({ records, tableNames: detectedTableNames }), {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=15" },
        }));
      } catch (_) {}
    }
    return records;
  })();
  globalThis.__dashboardRowsLoading = { key: cacheKey, promise };
  try { return await promise; }
  finally { if (globalThis.__dashboardRowsLoading?.promise === promise) globalThis.__dashboardRowsLoading = null; }
}

// Busca una OPA exacta directamente en SeaTable cuando no hay un snapshot
// reciente. Evita descargar miles de filas solo para mostrar uno o pocos matches.
export async function searchDashboardRecordsByOPA(env, query) {
  const cacheKey = [env.SEATABLE_BASE_UUID, env.SEATABLE_VIEW_NAME || "*", env.SEATABLE_COLUMN_MAP || "default"].join("|");
  const now = Date.now();
  const local = globalThis.__dashboardRowsCache;
  if (local?.key === cacheKey && local.expiresAt > now) {
    return local.records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
  }
  // La API SQL consulta la tabla completa, no una vista concreta. Si el
  // dashboard está configurado con una vista, respetamos ese alcance existente.
  if (env.SEATABLE_VIEW_NAME) {
    const records = await loadDashboardRecords(env);
    return records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
  }

  const sharedCache = getSharedDashboardCache(env);
  if (sharedCache) {
    try {
      const response = await sharedCache.match(dashboardCacheRequest(env));
      if (response) {
        const snapshot = await response.json();
        if (Array.isArray(snapshot.records) && Array.isArray(snapshot.tableNames)) {
          globalThis.__dashboardRowsCache = { key: cacheKey, records: snapshot.records, tableNames: snapshot.tableNames, expiresAt: Date.now() + 15_000 };
          return snapshot.records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
        }
      }
    } catch (_) {}
  }

  const token = await getBaseToken(env);
  const server = env.SEATABLE_SERVER_URL.replace(/\/$/, "");
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  const metadataResponse = await fetch(`${server}/api-gateway/api/v2/dtables/${baseId}/metadata/`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const metadata = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok) throw new Error(`No se pudo leer la estructura de SeaTable (HTTP ${metadataResponse.status}).`);
  const excluded = new Set(["USUARIOS", "HISTORIAL_AUDITORIA", "HISTORIAL DE AUTORIA"].map(normalizeHeader));
  const tables = (metadata.metadata?.tables || metadata.tables || []).filter((table) => table.name && !excluded.has(normalizeHeader(table.name)));
  const opaColumnName = normalizeHeader(getColumnMap(env).O);
  const searchable = tables.map((table) => ({
    name: table.name,
    opaColumn: (table.columns || []).find((column) => normalizeHeader(column.name) === opaColumnName)?.name,
  })).filter((table) => table.opaColumn);
  const columnMap = getColumnMap(env);
  const resultsByTable = new Map();
  let next = 0;
  async function searchTable(table) {
    const quote = (identifier) => `\`${String(identifier).replace(/`/g, "``")}\``;
    const response = await fetch(`${server}/api-gateway/api/v2/dtables/${baseId}/sql/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: `SELECT * FROM ${quote(table.name)} WHERE ${quote(table.opaColumn)} = ? LIMIT 10000`,
        parameters: [query],
        convert_keys: true,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`SeaTable no pudo buscar la OPA en "${table.name}" (HTTP ${response.status}).`);
    const rows = Array.isArray(body) ? body : (body.results || body.rows || body.data || []);
    const records = [];
    for (const row of rows) {
      // Garantiza coincidencia completa incluso si el motor convierte tipos.
      const opaKey = Object.keys(row).find((key) => normalizeHeader(key) === normalizeHeader(table.opaColumn));
      if (String(opaKey ? row[opaKey] : "").trim().toLocaleLowerCase() !== query) continue;
      records.push(toInternalRecord(row, table.name, getSourceKeyMap(row, columnMap)));
    }
    resultsByTable.set(table.name, records);
  }
  const concurrency = Math.min(4, searchable.length);
  async function worker() {
    while (next < searchable.length) await searchTable(searchable[next++]);
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } catch (_) {
    // Si la instalación de SeaTable no tiene habilitado SQL API, conservar
    // compatibilidad usando el método de lectura existente.
    const records = await loadDashboardRecords(env);
    return records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
  }
  return searchable.flatMap((table) => resultsByTable.get(table.name) || []).sort((a, b) => activityTime(b).localeCompare(activityTime(a)));
}

function getSharedDashboardCache(env) {
  try { return typeof caches !== "undefined" && caches.default ? caches.default : null; }
  catch (_) { return null; }
}

function dashboardCacheRequest(env) {
  const key = [env.SEATABLE_BASE_UUID, env.SEATABLE_VIEW_NAME || "*", env.SEATABLE_COLUMN_MAP || "default"].join("|");
  return new Request(`https://dashboard-cache.invalid/v1/${encodeURIComponent(key)}`);
}

export async function updateDashboardRow(env, tableName, rowId, values) {
  assertConfig(env);
  if (!tableName || !rowId || !values || typeof values !== "object" || !Object.keys(values).length) {
    throw new Error("Falta la tabla, el identificador de fila o el valor que se guardará.");
  }
  const authBaseMatchesDashboard = !env.SEATABLE_AUTH_BASE_UUID || env.SEATABLE_AUTH_BASE_UUID === env.SEATABLE_BASE_UUID;
  const writeApiToken = authBaseMatchesDashboard && env.SEATABLE_AUTH_API_TOKEN ? env.SEATABLE_AUTH_API_TOKEN : env.SEATABLE_API_TOKEN;
  const token = await getBaseToken(env, writeApiToken);
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  const url = `${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api-gateway/api/v2/dtables/${baseId}/rows/`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ table_name: tableName, updates: [{ row_id: rowId, row: values }] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(body.error_msg || body.error || body.detail || body.message || "").trim().slice(0, 240);
    throw new Error(`SeaTable no guardó los cambios en ${tableName} (HTTP ${response.status}). Verifica que SEATABLE_API_TOKEN tenga permiso de lectura y escritura.${detail ? ` ${detail}` : ""}`);
  }
  if (globalThis.__dashboardRowsCache?.key) globalThis.__dashboardRowsCache.expiresAt = 0;
  return body;
}

export async function createDashboardRow(env, tableName, values) {
  assertConfig(env);
  if (!tableName || !values || typeof values !== "object" || !Object.keys(values).length) {
    throw new Error("Falta la hoja o los datos del nuevo registro.");
  }
  const authBaseMatchesDashboard = !env.SEATABLE_AUTH_BASE_UUID || env.SEATABLE_AUTH_BASE_UUID === env.SEATABLE_BASE_UUID;
  const writeApiToken = authBaseMatchesDashboard && env.SEATABLE_AUTH_API_TOKEN ? env.SEATABLE_AUTH_API_TOKEN : env.SEATABLE_API_TOKEN;
  const token = await getBaseToken(env, writeApiToken);
  const url = `${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api-gateway/api/v2/dtables/${encodeURIComponent(env.SEATABLE_BASE_UUID)}/rows/`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ table_name: tableName, rows: [values] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(body.error_msg || body.error || body.detail || body.message || "").trim().slice(0, 240);
    throw new Error(`SeaTable no creó el registro (HTTP ${response.status}). Verifica que el token permita escritura.${detail ? ` ${detail}` : ""}`);
  }
  if (globalThis.__dashboardRowsCache?.key) globalThis.__dashboardRowsCache.expiresAt = 0;
  return body;
}

export async function getDashboardColumnType(env, tableName, columnName) {
  const token = await getBaseToken(env);
  const url = `${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api-gateway/api/v2/dtables/${encodeURIComponent(env.SEATABLE_BASE_UUID)}/metadata/`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`No se pudo verificar la columna de imágenes en SeaTable (HTTP ${response.status}).`);
  const tables = body.metadata?.tables || body.tables || [];
  const table = tables.find((item) => item.name === tableName);
  const column = table?.columns?.find((item) => normalizeHeader(item.name) === normalizeHeader(columnName));
  if (!column) throw new Error(`No se encontró la columna "${columnName}" en la hoja "${tableName}".`);
  return String(column.type || column.column_type || "").toLowerCase();
}

export async function getDashboardRow(env, tableName, rowId) {
  const token = await getBaseToken(env);
  const url = new URL(`${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api-gateway/api/v2/dtables/${encodeURIComponent(env.SEATABLE_BASE_UUID)}/rows/${encodeURIComponent(rowId)}/`);
  url.searchParams.set("table_name", tableName);
  url.searchParams.set("convert_keys", "true");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`No se pudo leer la fila seleccionada en SeaTable (HTTP ${response.status}).`);
  return body.row || body;
}

export async function getDashboardFileDownloadLink(env, path) {
  const authBaseMatchesDashboard = !env.SEATABLE_AUTH_BASE_UUID || env.SEATABLE_AUTH_BASE_UUID === env.SEATABLE_BASE_UUID;
  const apiToken = authBaseMatchesDashboard && env.SEATABLE_AUTH_API_TOKEN ? env.SEATABLE_AUTH_API_TOKEN : env.SEATABLE_API_TOKEN;
  if (!apiToken) throw new Error("Falta configurar el API token de SeaTable para mostrar imágenes.");
  const url = new URL(`${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api/v2.1/dtable/app-download-link/`);
  url.searchParams.set("path", path);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`SeaTable no pudo generar el enlace de la imagen (HTTP ${response.status}).`);
  const link = body.download_link || body.url || body.link;
  if (!link) throw new Error("SeaTable no devolvió el enlace temporal de la imagen.");
  return link;
}

export async function refreshForNewTables(env) {
  const cached = globalThis.__dashboardRowsCache;
  if (!cached || cached.expiresAt <= Date.now()) return loadDashboardRecords(env);
  const token = await getBaseToken(env);
  const currentNames = await discoverTableNames(env, token);
  const previous = [...(cached.tableNames || [])].sort().join("\u0000");
  const current = [...currentNames].sort().join("\u0000");
  if (previous === current) return cached.records;
  return loadDashboardRecords(env, { forceRefresh: true, tableNames: currentNames });
}



