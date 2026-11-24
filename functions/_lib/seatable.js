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
  OBS: "OBSERVACIÓN / NOVEDAD CG",
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
const DASHBOARD_DATA_VERSION = "all-rows-v3-search-duplicates";
// Reconciliar ediciones hechas directamente en SeaTable, sin escanear toda la
// base en cada sondeo ligero del dashboard.
const DASHBOARD_SNAPSHOT_MAX_AGE_MS = 30_000;

function dashboardDataCacheKey(env) {
  return [DASHBOARD_DATA_VERSION, env.SEATABLE_BASE_UUID, env.SEATABLE_VIEW_NAME || "*", env.SEATABLE_COLUMN_MAP || "default"].join("|");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Tiempo de espera agotado")), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`SeaTable tardó más de ${Math.round(timeoutMs / 1000)} segundos en responder.`);
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

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

export function getDashboardColumnMap(env) {
  return getColumnMap(env);
}

async function getBaseToken(env, apiToken = env.SEATABLE_API_TOKEN, options = {}) {
  const now = Date.now();
  const cached = globalThis.__seatableToken;
  if (cached?.key === apiToken && cached.expiresAt > now + 60_000) return cached.value;

  const response = await fetchWithTimeout(`${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api/v2.1/dtable/app-access-token/`, {
    headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
    signal: options.signal,
  }, options.timeoutMs || 10_000);
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

export async function discoverTableNames(env, token = null, options = {}) {
  const metadataCacheKey = String(env.SEATABLE_BASE_UUID || "");
  const cachedMetadata = globalThis.__seatableMetadataCache;
  if (cachedMetadata?.key === metadataCacheKey && cachedMetadata.expiresAt > Date.now() && Array.isArray(cachedMetadata.tables)) {
    return dashboardDataTableNames(cachedMetadata.tables);
  }
  const server = env.SEATABLE_SERVER_URL.replace(/\/$/, "");
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  const accessToken = token || await getBaseToken(env);
  const metadataUrl = `${server}/api-gateway/api/v2/dtables/${baseId}/metadata/`;
  const metadataResponse = await fetchWithTimeout(metadataUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: options.signal,
  }, options.timeoutMs || 10_000);
  const metadataBody = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok) throw new Error(`No se pudo leer la lista de pestañas de SeaTable (HTTP ${metadataResponse.status}).`);
  const tables = metadataBody.metadata?.tables || metadataBody.tables || [];
  globalThis.__seatableMetadataCache = { key: metadataCacheKey, tables, expiresAt: Date.now() + 60_000 };
  return dashboardDataTableNames(tables);
}

function dashboardDataTableNames(tables) {
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
  // La metadata aporta el esquema de cada hoja y permite pedir por SQL solo
  // las columnas que consume el Dashboard, en vez de bajar todas las columnas.
  const discoveredNames = await discoverTableNames(env, token);
  const tableNames = knownTableNames || discoveredNames;
  if (!tableNames.length) throw new Error("No se encontraron tablas en la base SeaTable. Revisa permisos y configuración.");

  const columnMap = getColumnMap(env);
  const metadataTables = globalThis.__seatableMetadataCache?.tables || [];
  const projectedColumnsByTable = new Map();
  for (const tableName of tableNames) {
    const table = metadataTables.find((item) => item.name === tableName);
    const availableColumns = Array.isArray(table?.columns) ? table.columns : [];
    if (!availableColumns.length) continue;
    const byNormalizedName = new Map();
    for (const column of availableColumns) {
      for (const candidate of [column.name, column.key]) {
        const normalized = normalizeHeader(candidate);
        if (normalized && !byNormalizedName.has(normalized)) byNormalizedName.set(normalized, candidate);
      }
    }
    const selected = new Set(["_id", "_ctime", "_mtime"]);
    for (const configuredName of Object.values(columnMap)) {
      const actualName = byNormalizedName.get(normalizeHeader(configuredName));
      if (actualName) selected.add(actualName);
    }
    // Evita una consulta vacía si el esquema de metadata no coincide con lo esperado.
    if (selected.size > 3) projectedColumnsByTable.set(tableName, [...selected]);
  }

  const pageSize = 1000;
  // Las hojas son independientes; limitamos la concurrencia para acelerar la
  // carga sin disparar cientos de solicitudes a SeaTable.
  const maxConcurrentTables = Math.min(8, tableNames.length);
  let nextTableIndex = 0;
  async function readTableWithRowsAPI(tableName) {
    const tableRows = [];
    for (let start = 0; ; start += pageSize) {
      const url = new URL(`${server}/api-gateway/api/v2/dtables/${baseId}/rows/`);
      url.searchParams.set("table_name", tableName);
      url.searchParams.set("start", String(start));
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("convert_keys", "true");
      const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }, 15_000);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Error leyendo la tabla "${tableName}" de SeaTable (HTTP ${response.status}).`);
      const rows = Array.isArray(body) ? body : (body.rows || body.results || []);
      tableRows.push(...rows);
      if (rows.length < pageSize) break;
      if (start + rows.length >= 100_000) throw new Error("La lectura supera el tope de seguridad de 100.000 filas. Usa vistas o consulta por páginas/filtros.");
    }
    return tableRows;
  }
  async function readTableWithSql(tableName) {
    const tableRows = [];
    const quotedTable = `\`${String(tableName).replace(/`/g, "``")}\``;
    const selectedColumns = projectedColumnsByTable.get(tableName);
    const projection = selectedColumns
      ? selectedColumns.map((column) => "`" + String(column).replace(/`/g, "``") + "`").join(", ")
      : "*";
    const sqlPageSize = 10_000;
    for (let offset = 0; ; offset += sqlPageSize) {
      const response = await fetchWithTimeout(`${server}/api-gateway/api/v2/dtables/${baseId}/sql/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ sql: `SELECT ${projection} FROM ${quotedTable} LIMIT ${sqlPageSize} OFFSET ${offset}`, convert_keys: true }),
      }, 15_000);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`No se pudo leer la hoja "${tableName}" con SQL (HTTP ${response.status}).`);
      const rows = Array.isArray(body) ? body : [body.results, body.rows, body.data].find(Array.isArray);
      if (!Array.isArray(rows)) throw new Error(`SeaTable devolvió un formato inesperado para la hoja "${tableName}".`);
      if (selectedColumns && rows.length && !Object.prototype.hasOwnProperty.call(rows[0], "_id")) {
        throw new Error(`La consulta de columnas de "${tableName}" no devolvió el identificador de fila.`);
      }
      tableRows.push(...rows);
      if (rows.length < sqlPageSize) break;
      if (offset + rows.length >= 100_000) throw new Error("La lectura supera el tope de seguridad de 100.000 filas. Usa vistas o consulta por páginas/filtros.");
    }
    return tableRows;
  }
  async function readTable(tableName) {
    // El dashboard debe leer todas las filas de la tabla, no solo las visibles
    // en una vista de SeaTable que puede tener filtros propios. SQL conserva
    // la proyección de columnas y trae más filas por petición; si no está
    // disponible, el endpoint paginado también se consulta sin view_name.
    try { return await readTableWithSql(tableName); }
    catch (projectionError) {
      // Un timeout indica que SeaTable está lento; volver a pedir la misma
      // tabla por otra API solo alarga la espera y puede agotar Pages Functions.
      if (/tardó más de/i.test(String(projectionError && projectionError.message || projectionError))) throw projectionError;
      if (projectedColumnsByTable.has(tableName)) {
        // Si SeaTable no admite alguna columna proyectada, intenta la consulta
        // SQL completa antes de caer al API paginado más lento.
        projectedColumnsByTable.delete(tableName);
        try { return await readTableWithSql(tableName); }
        catch (fallbackError) {
          if (/tardó más de/i.test(String(fallbackError && fallbackError.message || fallbackError))) throw fallbackError;
        }
      }
      return readTableWithRowsAPI(tableName);
    }
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
    if ((internal === "LF" || internal === "GE") && Array.isArray(value)) result[internal] = value;
    else if (internal === "MR" || internal === "ME") result[internal] = Number(value) || 0;
    else if (internal === "F" || (internal.length === 2 && internal[0] === "F") || internal === "FM") result[internal] = normalizeDate(value);
    else result[internal] = String(value).trim();
  }
  result._id = row._id || "";
  // Conservar los metadatos de creación y modificación de SeaTable. El panel
  // de consultas usa _ctime para contar registros realmente creados por fecha;
  // _mtime se mantiene para ordenar cambios posteriores.
  result._ctime = row._ctime || row._created_at || "";
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
  // Para copias repetidas de una misma OPA, la fila modificada más recientemente
  // debe prevalecer incluso si una fila antigua tiene fechas de etapa posteriores.
  const modified = record._mtime || record._ctime || "";
  const modifiedNumber = Number(modified);
  if (Number.isFinite(modifiedNumber) && modifiedNumber > 0) {
    return modifiedNumber < 100_000_000_000 ? modifiedNumber * 1000 : modifiedNumber;
  }
  const modifiedAt = Date.parse(String(modified));
  if (Number.isFinite(modifiedAt) && modifiedAt > 0) return modifiedAt;

  // Respaldo para filas que no traen metadatos de modificación.
  let latestStage = 0;
  for (const key of ["F8", "F7", "F6", "F5", "F4", "F3", "F2", "F1", "FM", "F"]) {
    const stageAt = Date.parse(String(record[key] || ""));
    if (Number.isFinite(stageAt) && stageAt > latestStage) latestStage = stageAt;
  }
  return latestStage;
}

export async function loadDashboardRecords(env, { forceRefresh = false, tableNames = null, includeDuplicates = false } = {}) {
  const cacheKey = dashboardDataCacheKey(env);
  const now = Date.now();
  let cached = globalThis.__dashboardRowsCache;
  if (!forceRefresh && cached?.key === cacheKey && cached.expiresAt > now) return cached.records;
  // Cache API de Cloudflare comparte el resultado entre solicitudes/aislamientos
  // cercanos. Así los usuarios concurrentes no vuelven a leer todas las hojas.
  const sharedCache = getSharedDashboardCache(env);
  const sharedRequest = dashboardCacheRequest(env);
  let ownsRefreshLease = false;
  if (!forceRefresh && sharedCache) {
    const shared = await readSharedDashboardSnapshot(sharedCache, sharedRequest);
    if (shared) {
      const lockRequest = dashboardCacheRequest(env, "refresh-lock");
      const lockResponse = await sharedCache.match(lockRequest);
      if (lockResponse) {
        const lock = await lockResponse.json().catch(() => ({}));
        if (Number(shared.updatedAt || 0) < Number(lock.startedAt || 0)) {
          // La carga normal devuelve la copia existente de inmediato; el lease
          // indica que otro usuario ya está preparando la versión nueva.
          globalThis.__dashboardRowsCache = { key: cacheKey, records: shared.records, duplicateRecords: shared.duplicateRecords || shared.records, tableNames: shared.tableNames, updatedAt: shared.updatedAt, expiresAt: Date.now() + 60_000 };
          return shared.records;
        } else {
          globalThis.__dashboardRowsCache = { key: cacheKey, records: shared.records, duplicateRecords: shared.duplicateRecords || shared.records, tableNames: shared.tableNames, updatedAt: shared.updatedAt, expiresAt: Date.now() + 60_000 };
          return shared.records;
        }
      } else {
        globalThis.__dashboardRowsCache = { key: cacheKey, records: shared.records, duplicateRecords: shared.duplicateRecords || shared.records, tableNames: shared.tableNames, updatedAt: shared.updatedAt, expiresAt: Date.now() + 60_000 };
        return shared.records;
      }
    }
  }
  // En un isolate nuevo, si Cache API no tiene copia, lee el snapshot persistido
  // en R2 y responde sin esperar un escaneo completo de todas las hojas.
  if (!forceRefresh && (!cached || cached.key !== cacheKey)) {
    const durable = await readDurableDashboardSnapshot(env);
    if (durable) {
      const restoredAt = Number(durable.updatedAt || Date.now());
      cached = { key: cacheKey, records: durable.records,
        duplicateRecords: durable.duplicateRecords || durable.records,
        tableNames: durable.tableNames, revision: durable.revision || "", updatedAt: restoredAt, expiresAt: Date.now() + 60_000 };
      globalThis.__dashboardRowsCache = cached;
      if (sharedCache) {
        try {
          await sharedCache.put(sharedRequest, new Response(JSON.stringify({
            records: durable.records, tableNames: durable.tableNames, revision: durable.revision || "", updatedAt: restoredAt,
          }), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" } }));
          await writeSharedDashboardMetadata(sharedCache, env, durable);
        } catch (_) {}
      }
      return durable.records;
    }
  }
  if (sharedCache && !includeDuplicates) {
    const lockRequest = dashboardCacheRequest(env, "refresh-lock");
    // Una pequeña espera escalonada permite que el primer usuario publique el
    // lease antes de que los demás decidan iniciar otra lectura completa.
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 180)));
    let lockResponse = await sharedCache.match(lockRequest);
    if (lockResponse) {
      const lock = await lockResponse.json().catch(() => ({}));
      // En el primer arranque puede no existir aún una copia compartida. Espera
      // brevemente a que el primer lector la publique, en vez de esperar 75 s.
      const refreshed = await waitForSharedDashboardRefresh(sharedCache, sharedRequest, lockRequest, Number(lock.startedAt || Date.now()), 24_000);
      if (refreshed) {
        globalThis.__dashboardRowsCache = { key: cacheKey, records: refreshed.records, duplicateRecords: refreshed.duplicateRecords || refreshed.records, tableNames: refreshed.tableNames, updatedAt: refreshed.updatedAt, expiresAt: Date.now() + 60_000 };
        return refreshed.records;
      }
      // La actualización del otro usuario falló o venció el lease; intentar una.
      lockResponse = await sharedCache.match(lockRequest);
      if (lockResponse) throw new Error("La actualización compartida sigue en curso. Conservamos la copia disponible; vuelve a intentar en unos segundos.");
    }
    if (!lockResponse) {
      const startedAt = Date.now();
      try {
        await sharedCache.put(lockRequest, new Response(JSON.stringify({ startedAt }), {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=90" },
        }));
        ownsRefreshLease = true;
      } catch (_) {}
    }
  }

  const promise = (async () => {
    const scanRevision = await readDashboardSnapshotRevision(sharedCache, env);
    const columnMap = getColumnMap(env);
    const schemaByTable = new Map();
    const latest = new Map();
    const withoutOPA = [];
    const allRecords = [];
    const opaRecords = [];
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
      allRecords.push(record);
      const opa = String(record.O || "").trim();
      if (!opa) { withoutOPA.push(record); return; }
      opaRecords.push(record);
      const project = String(record.P || "").trim().toLocaleUpperCase();
      const key = `${project}\u0000${opa}`;
      const current = latest.get(key);
      if (!current || activityTime(record) >= activityTime(current)) latest.set(key, record);
    }, tableNames);
    const records = [...latest.values(), ...withoutOPA];
    // Refresca los registros junto con el sondeo del dashboard, para que los
    // cambios en filas existentes no queden ocultos detrás de una caché larga.
    // La acción manual "Actualizar datos" sigue forzando una lectura inmediata.
    // Publish a completed scan even if a write happened during it. Keep the
    // older scanRevision on the snapshot so the next quiet-window refresh knows
    // it must catch up; discarding every scan during active work can starve the
    // shared cache forever when several people are editing at once.
    const updatedAt = Date.now();
    globalThis.__dashboardRowsCache = { key: cacheKey, records, duplicateRecords: opaRecords, tableNames: detectedTableNames, revision: scanRevision, updatedAt, expiresAt: updatedAt + 60_000 };
    if (sharedCache) {
      try {
        await sharedCache.put(sharedRequest, new Response(JSON.stringify({ records, duplicateRecords: opaRecords, tableNames: detectedTableNames, revision: scanRevision, updatedAt }), {
          // Keep a usable snapshot available while a newer scan runs. Freshness
          // is controlled by updatedAt/revision below, not by Cache API expiry.
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
        }));
        await writeSharedDashboardMetadata(sharedCache, env, { records, revision: scanRevision, updatedAt });
      } catch (_) {}
    }
    await writeDurableDashboardSnapshot(env, { records, duplicateRecords: opaRecords, tableNames: detectedTableNames, revision: scanRevision, updatedAt });
    return includeDuplicates ? allRecords : records;
  })().finally(async () => {
    if (ownsRefreshLease && sharedCache) {
      try { await sharedCache.delete(dashboardCacheRequest(env, "refresh-lock")); } catch (_) {}
    }
  });
  return await promise;
}

// Busca dentro de la copia compartida del dashboard. La copia se actualiza
// con el sondeo periódico del dashboard, sin hacer una consulta a SeaTable
// por cada búsqueda.
export async function searchDashboardRecordsByOPA(env, query) {
  const cacheKey = dashboardDataCacheKey(env);
  let records = globalThis.__dashboardRowsCache?.key === cacheKey
    ? (globalThis.__dashboardRowsCache.duplicateRecords || globalThis.__dashboardRowsCache.records)
    : null;

  // La búsqueda no debe iniciar un escaneo completo de SeaTable en una
  // instancia fría. Usa el snapshot compartido si ya existe; el dashboard
  // sigue siendo responsable de crearlo y renovarlo.
  if (!Array.isArray(records)) {
    const sharedCache = getSharedDashboardCache(env);
    const snapshot = sharedCache ? await readSharedDashboardSnapshot(sharedCache, dashboardCacheRequest(env)) : null;
    if (snapshot) {
      records = snapshot.duplicateRecords || snapshot.records;
      globalThis.__dashboardRowsCache = {
        key: cacheKey,
        records: snapshot.records,
        duplicateRecords: records,
        tableNames: snapshot.tableNames,
        revision: snapshot.revision || "",
        updatedAt: snapshot.updatedAt,
        expiresAt: Date.now() + 60_000,
      };
    }
  }
  if (!Array.isArray(records)) {
    throw new Error("La copia del dashboard todavía no está disponible en esta región. Abre Dashboard o pulsa «Actualizar datos» y vuelve a buscar.");
  }
  const needle = String(query || "").trim().toLocaleLowerCase();
  return records
    .filter((record) => String(record.O || "").trim().toLocaleLowerCase() === needle)
    .sort((a, b) => String(activityTime(b)).localeCompare(String(activityTime(a))));
}

function getSharedDashboardCache(env) {
  try { return typeof caches !== "undefined" && caches.default ? caches.default : null; }
  catch (_) { return null; }
}

function dashboardCacheRequest(env, suffix = "snapshot") {
  const key = dashboardDataCacheKey(env);
  return new Request(`https://dashboard-cache.invalid/v1/${encodeURIComponent(key)}/${suffix}`);
}

async function dashboardSnapshotObjectKey(env) {
  const data = new TextEncoder().encode(dashboardDataCacheKey(env));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `dashboard/snapshots/${hash}.json`;
}

async function readDurableDashboardSnapshot(env) {
  const bucket = env.DASHBOARD_EXCEL;
  if (!bucket || typeof bucket.get !== "function") return null;
  try {
    const object = await bucket.get(await dashboardSnapshotObjectKey(env));
    if (!object) return null;
    const snapshot = await object.json();
    if (snapshot.version !== DASHBOARD_DATA_VERSION || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.tableNames)) return null;
    return snapshot;
  } catch (error) {
    console.warn("No se pudo leer la copia persistente del dashboard:", error?.message || error);
    return null;
  }
}

async function writeDurableDashboardSnapshot(env, snapshot) {
  const bucket = env.DASHBOARD_EXCEL;
  if (!bucket || typeof bucket.put !== "function") return;
  try {
    const key = await dashboardSnapshotObjectKey(env);
    const serialized = JSON.stringify({
      version: DASHBOARD_DATA_VERSION,
      records: snapshot.records,
      duplicateRecords: snapshot.duplicateRecords || snapshot.records,
      tableNames: snapshot.tableNames,
      revision: snapshot.revision || "",
      updatedAt: Number(snapshot.updatedAt || Date.now()),
    });
    const digestSource = JSON.stringify({
      version: DASHBOARD_DATA_VERSION,
      records: snapshot.records,
      duplicateRecords: snapshot.duplicateRecords || snapshot.records,
      tableNames: snapshot.tableNames,
      revision: snapshot.revision || "",
    });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(digestSource)));
    const contentHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const existing = typeof bucket.head === "function" ? await bucket.head(key) : null;
    // Evita escribir en R2 cada minuto si la lectura devuelve los mismos datos.
    // Renueva la copia durable como mínimo cada cinco minutos.
    const lastWriteAt = Number(existing?.customMetadata?.snapshotAt || 0);
    if (existing?.customMetadata?.contentHash === contentHash && Date.now() - lastWriteAt < 5 * 60_000) return;
    await bucket.put(key, serialized, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { recordCount: String(snapshot.records.length), snapshotAt: String(snapshot.updatedAt || Date.now()), revision: String(snapshot.revision || ""), contentHash },
    });
  } catch (error) {
    // R2 mejora la recuperación tras un cold start, pero no debe hacer fallar
    // una lectura correcta de SeaTable si la copia durable no puede guardarse.
    console.warn("No se pudo guardar la copia persistente del dashboard:", error?.message || error);
  }
}

async function readSharedDashboardSnapshot(cache, request) {
  try {
    const response = await cache.match(request);
    if (!response) return null;
    const snapshot = await response.json();
    return Array.isArray(snapshot.records) && Array.isArray(snapshot.tableNames) ? snapshot : null;
  } catch (_) { return null; }
}
function dashboardSnapshotMetadataRequest(env) {
  return dashboardCacheRequest(env, "snapshot-meta");
}

async function readSharedDashboardMetadata(cache, env) {
  if (!cache) return null;
  try {
    const response = await cache.match(dashboardSnapshotMetadataRequest(env));
    if (!response) return null;
    const metadata = await response.json();
    return Number.isFinite(Number(metadata.updatedAt)) && Number.isFinite(Number(metadata.recordCount)) ? metadata : null;
  } catch (_) { return null; }
}

async function writeSharedDashboardMetadata(cache, env, snapshot) {
  if (!cache || typeof cache.put !== "function") return;
  const metadata = {
    recordCount: Array.isArray(snapshot.records) ? snapshot.records.length : Number(snapshot.recordCount) || 0,
    updatedAt: Number(snapshot.updatedAt) || Date.now(),
    revision: String(snapshot.revision || ""),
  };
  try {
    await cache.put(dashboardSnapshotMetadataRequest(env), new Response(JSON.stringify(metadata), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    }));
  } catch (_) {}
  globalThis.__dashboardSnapshotMetadata = { key: dashboardDataCacheKey(env), ...metadata };
}

async function readDurableDashboardMetadata(env) {
  const bucket = env.DASHBOARD_EXCEL;
  if (!bucket || typeof bucket.head !== "function") return null;
  try {
    const head = await bucket.head(await dashboardSnapshotObjectKey(env));
    if (!head) return null;
    const custom = head.customMetadata || {};
    const updatedAt = Number(custom.snapshotAt) || Number(head.uploaded?.getTime?.()) || 0;
    if (!updatedAt) return null;
    return { recordCount: Number(custom.recordCount) || 0, updatedAt, revision: String(custom.revision || ""), contentHash: String(custom.contentHash || "") };
  } catch (_) { return null; }
}

async function scheduleDashboardBackgroundRefresh(env, context, cache, cacheKey) {
  if (!context || typeof context.waitUntil !== "function") return false;
  const pending = globalThis.__dashboardBackgroundRefresh;
  if (pending?.key === cacheKey) return true;
  const lockRequest = dashboardCacheRequest(env, "checksum-refresh-lock");
  if (cache) {
    try {
      if (await cache.match(lockRequest)) return true;
      await cache.put(lockRequest, new Response(JSON.stringify({ startedAt: Date.now() }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=90" },
      }));
    } catch (_) {}
  }
  const promise = loadDashboardRecords(env, { forceRefresh: true })
    .catch((error) => console.warn("Dashboard background refresh failed:", error?.message || error))
    .finally(async () => {
      if (cache) { try { await cache.delete(lockRequest); } catch (_) {} }
      if (globalThis.__dashboardBackgroundRefresh?.promise === promise) globalThis.__dashboardBackgroundRefresh = null;
    });
  globalThis.__dashboardBackgroundRefresh = { key: cacheKey, promise };
  context.waitUntil(promise);
  return true;
}

// El checksum lee únicamente metadatos pequeños; no descarga ni parsea miles de filas.
export async function getDashboardSnapshotStatus(env, context = null) {
  const cacheKey = dashboardDataCacheKey(env);
  const sharedCache = getSharedDashboardCache(env);
  let metadata = await readSharedDashboardMetadata(sharedCache, env);
  if (!metadata && globalThis.__dashboardSnapshotMetadata?.key === cacheKey) metadata = globalThis.__dashboardSnapshotMetadata;
  if (!metadata && globalThis.__dashboardRowsCache?.key === cacheKey) {
    const local = globalThis.__dashboardRowsCache;
    metadata = { recordCount: local.records.length, updatedAt: Number(local.updatedAt) || 0, revision: String(local.revision || "") };
  }
  if (!metadata) metadata = await readDurableDashboardMetadata(env);
  if (!metadata) {
    const refreshing = await scheduleDashboardBackgroundRefresh(env, context, sharedCache, cacheKey);
    return { etag: "snapshot-v4-pending", totalRegistros: 0, updatedAt: 0, refreshing };
  }
  const ageMs = Date.now() - Number(metadata.updatedAt || 0);
  const revision = await readDashboardSnapshotRevision(sharedCache, env);
  // Si una escritura invalidó el snapshot y no se pudo propagar, reconciliarla
  // en el siguiente sondeo en vez de esperar a que venza el snapshot.
  const changedWhileEditing = Boolean(revision && String(metadata.revision || "") !== revision);
  const stale = ageMs >= DASHBOARD_SNAPSHOT_MAX_AGE_MS || changedWhileEditing;
  let refreshLock = null;
  if (sharedCache) {
    try {
      refreshLock = await sharedCache.match(dashboardCacheRequest(env, "checksum-refresh-lock"))
        || await sharedCache.match(dashboardCacheRequest(env, "refresh-lock"));
    } catch (_) {}
  }
  const refreshing = !!refreshLock || (stale ? await scheduleDashboardBackgroundRefresh(env, context, sharedCache, cacheKey) : false);
  const version = String(metadata.revision || metadata.contentHash || "");
  return {
    etag: `snapshot-v4-${Number(metadata.recordCount) || 0}-${Number(metadata.updatedAt) || 0}-${version}`,
    totalRegistros: Number(metadata.recordCount) || 0,
    updatedAt: Number(metadata.updatedAt) || 0,
    refreshing,
  };
}

// Inicia una lectura manual sin volver a descargar el snapshot completo en la
// solicitud del botón. El cliente conserva su copia visible y el checksum
// detecta la nueva versión cuando termina el escaneo en segundo plano.
export async function requestDashboardRefresh(env, context = null) {
  const cacheKey = dashboardDataCacheKey(env);
  const sharedCache = getSharedDashboardCache(env);
  let metadata = await readSharedDashboardMetadata(sharedCache, env);
  if (!metadata && globalThis.__dashboardSnapshotMetadata?.key === cacheKey) metadata = globalThis.__dashboardSnapshotMetadata;
  if (!metadata && globalThis.__dashboardRowsCache?.key === cacheKey) {
    const local = globalThis.__dashboardRowsCache;
    metadata = { recordCount: local.records.length, updatedAt: Number(local.updatedAt) || 0, revision: String(local.revision || "") };
  }
  if (!metadata) metadata = await readDurableDashboardMetadata(env);

  if (context && typeof context.waitUntil === "function") {
    await scheduleDashboardBackgroundRefresh(env, context, sharedCache, cacheKey);
    return { totalRegistros: Number(metadata?.recordCount || 0), updatedAt: Number(metadata?.updatedAt || 0), refreshing: true };
  }

  const records = await loadDashboardRecords(env, { forceRefresh: true });
  const refreshed = globalThis.__dashboardRowsCache;
  return { totalRegistros: records.length, updatedAt: Number(refreshed?.updatedAt || Date.now()), refreshing: false };
}


async function readDashboardSnapshotRevision(cache, env) {
  if (!cache) return "";
  try {
    const response = await cache.match(dashboardCacheRequest(env, "revision"));
    if (!response) return "";
    const value = await response.json();
    return String(value.revision || "");
  } catch (_) { return ""; }
}

async function waitForSharedDashboardRefresh(cache, snapshotRequest, lockRequest, startedAt, maxWaitMs = 12_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const snapshot = await readSharedDashboardSnapshot(cache, snapshotRequest);
    if (snapshot && Number(snapshot.updatedAt || 0) >= startedAt) return snapshot;
    if (!(await cache.match(lockRequest))) return null;
  }
  return null;
}

export async function updateDashboardRow(env, tableName, rowId, values, context = null) {
  assertConfig(env);
  if (!tableName || !rowId || !values || typeof values !== "object" || !Object.keys(values).length) {
    throw new Error("Falta la tabla, el identificador de fila o el valor que se guardará.");
  }
  const authBaseMatchesDashboard = !env.SEATABLE_AUTH_BASE_UUID || env.SEATABLE_AUTH_BASE_UUID === env.SEATABLE_BASE_UUID;
  const writeApiToken = authBaseMatchesDashboard && env.SEATABLE_AUTH_API_TOKEN ? env.SEATABLE_AUTH_API_TOKEN : env.SEATABLE_API_TOKEN;
  const token = await getBaseToken(env, writeApiToken);
  const canonicalValues = await resolveTableColumnNames(env, tableName, values);
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  const url = `${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api-gateway/api/v2/dtables/${baseId}/rows/`;
  const response = await fetchWithTimeout(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ table_name: tableName, updates: [{ row_id: rowId, row: canonicalValues }] }),
  }, 15_000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(body.error_msg || body.error || body.detail || body.message || "").trim().slice(0, 240);
    throw new Error(`SeaTable no guardó los cambios en ${tableName} (HTTP ${response.status}). Verifica que SEATABLE_API_TOKEN tenga permiso de lectura y escritura.${detail ? ` ${detail}` : ""}`);
  }
  const publishUpdate = async () => {
    try {
      const published = await publishUpdatedDashboardRecord(env, tableName, rowId, canonicalValues);
      if (!published) await invalidateDashboardSnapshot(env);
    } catch (error) {
      console.warn("No se pudo propagar el cambio a la copia del dashboard:", error?.message || error);
      await invalidateDashboardSnapshot(env);
    }
  };
  // El guardado en SeaTable ya terminó. La propagación al snapshot puede
  // serializar miles de filas; no debe convertir un guardado exitoso en 503.
  if (typeof context?.waitUntil === "function") context.waitUntil(publishUpdate());
  else await publishUpdate();
  return body;
}

export async function createDashboardRow(env, tableName, values, context = null) {
  assertConfig(env);
  if (!tableName || !values || typeof values !== "object" || !Object.keys(values).length) {
    throw new Error("Falta la hoja o los datos del nuevo registro.");
  }
  const authBaseMatchesDashboard = !env.SEATABLE_AUTH_BASE_UUID || env.SEATABLE_AUTH_BASE_UUID === env.SEATABLE_BASE_UUID;
  const writeApiToken = authBaseMatchesDashboard && env.SEATABLE_AUTH_API_TOKEN ? env.SEATABLE_AUTH_API_TOKEN : env.SEATABLE_API_TOKEN;
  const token = await getBaseToken(env, writeApiToken);
  const canonicalValues = await resolveTableColumnNames(env, tableName, values, true);
  const url = `${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api-gateway/api/v2/dtables/${encodeURIComponent(env.SEATABLE_BASE_UUID)}/rows/`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ table_name: tableName, rows: [canonicalValues] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(body.error_msg || body.error || body.detail || body.message || "").trim().slice(0, 240);
    throw new Error(`SeaTable no creó el registro (HTTP ${response.status}). Verifica que el token permita escritura.${detail ? ` ${detail}` : ""}`);
  }
  const snapshotUpdate = publishCreatedDashboardRecord(env, tableName, canonicalValues, extractCreatedRowId(body))
    .then(async (published) => { if (!published) await invalidateDashboardSnapshot(env); })
    .catch((error) => console.warn("No se pudo propagar la nueva OPA a la copia compartida:", error?.message || error));
  if (typeof context?.waitUntil === "function") context.waitUntil(snapshotUpdate);
  else await snapshotUpdate;
  return body;
}

function extractCreatedRowId(body) {
  const candidates = [
    body?.row_id, body?.rowId, body?._id, body?.id,
    body?.inserted_row_id, body?.row?.row_id, body?.row?._id, body?.row?.id,
    body?.row_ids?.[0], body?.rows?.[0]?.row_id, body?.rows?.[0]?._id,
    body?.rows?.[0]?.id, body?.inserted_rows?.[0]?.row_id,
    body?.inserted_rows?.[0]?._id, body?.inserted_rows?.[0]?.id,
    body?.data?.row_id, body?.data?.row_ids?.[0], body?.data?.rows?.[0]?.row_id,
  ];
  return String(candidates.find((value) => value != null && String(value).trim()) || "").trim();
}

async function publishCreatedDashboardRecord(env, tableName, canonicalValues, rowId) {
  const cacheKey = dashboardDataCacheKey(env);
  const cache = getSharedDashboardCache(env);
  let snapshot = cache ? await readSharedDashboardSnapshot(cache, dashboardCacheRequest(env)) : null;
  if (!snapshot && globalThis.__dashboardRowsCache?.key === cacheKey && Array.isArray(globalThis.__dashboardRowsCache.records)) {
    const local = globalThis.__dashboardRowsCache;
    snapshot = { records: local.records, duplicateRecords: local.duplicateRecords || local.records, tableNames: local.tableNames || [], revision: local.revision || "", updatedAt: local.updatedAt || 0 };
  }
  if (!snapshot) snapshot = await readDurableDashboardSnapshot(env);
  if (!snapshot || !Array.isArray(snapshot.records)) return false;

  const createdAt = new Date().toISOString();
  const internalRow = toInternalRecord({
    ...canonicalValues,
    _id: rowId || `created-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    _ctime: createdAt,
    _mtime: createdAt,
  }, tableName, getSourceKeyMap(canonicalValues, getColumnMap(env)));
  const existingIndex = snapshot.records.findIndex((record) =>
    (rowId && String(record._id || "") === rowId && String(record.H || "") === tableName) ||
    (String(record.H || "") === tableName && String(record.O || "").trim() === String(internalRow.O || "").trim())
  );
  const records = snapshot.records.slice();
  if (existingIndex >= 0) records[existingIndex] = internalRow;
  else records.push(internalRow);
  const duplicateRecords = (snapshot.duplicateRecords || snapshot.records).slice();
  const duplicateIndex = rowId ? duplicateRecords.findIndex((record) => String(record._id || "") === rowId && String(record.H || "") === tableName) : -1;
  if (duplicateIndex >= 0) duplicateRecords[duplicateIndex] = internalRow;
  else duplicateRecords.push(internalRow);
  const now = Date.now();
  const updated = {
    records,
    duplicateRecords,
    tableNames: Array.from(new Set([...(snapshot.tableNames || []), tableName])),
    revision: `${now}-${Math.random().toString(36).slice(2)}`,
    updatedAt: now,
  };

  globalThis.__dashboardRowsCache = { key: cacheKey, ...updated, expiresAt: now + 60_000 };
  if (cache) {
    try {
      await cache.put(dashboardCacheRequest(env), new Response(JSON.stringify(updated), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
      }));
      await writeSharedDashboardMetadata(cache, env, updated);
      await cache.put(dashboardCacheRequest(env, "revision"), new Response(JSON.stringify({ revision: updated.revision, updatedAt: now }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
      }));
    } catch (_) {}
  }
  await writeDurableDashboardSnapshot(env, updated);
  return true;
}

async function publishUpdatedDashboardRecord(env, tableName, rowId, canonicalValues) {
  const cacheKey = dashboardDataCacheKey(env);
  const cache = getSharedDashboardCache(env);
  let snapshot = cache ? await readSharedDashboardSnapshot(cache, dashboardCacheRequest(env)) : null;
  if (!snapshot && globalThis.__dashboardRowsCache?.key === cacheKey) {
    const local = globalThis.__dashboardRowsCache;
    snapshot = { records: local.records, duplicateRecords: local.duplicateRecords || local.records, tableNames: local.tableNames || [], revision: local.revision || "", updatedAt: local.updatedAt || 0 };
  }
  if (!snapshot) snapshot = await readDurableDashboardSnapshot(env);
  if (!snapshot || !Array.isArray(snapshot.records)) return false;

  const columns = getColumnMap(env);
  const internalUpdates = {};
  for (const [columnName, value] of Object.entries(canonicalValues || {})) {
    const key = Object.keys(columns).find((candidate) => normalizeHeader(columns[candidate]) === normalizeHeader(columnName));
    if (key) internalUpdates[key] = value;
  }
  const matchesRow = (record) => String(record.H || "") === String(tableName) && String(record._id || "") === String(rowId);
  const previousRows = snapshot.duplicateRecords || snapshot.records;
  const duplicateRecords = previousRows.map((record) => matchesRow(record)
    ? { ...record, ...internalUpdates, _mtime: new Date().toISOString() }
    : record);
  if (!duplicateRecords.some(matchesRow) && !snapshot.records.some(matchesRow)) return false;

  const withoutOpa = snapshot.records.filter((record) => !String(record.O || "").trim());
  const latest = new Map();
  for (const record of duplicateRecords) {
    const opa = String(record.O || "").trim();
    if (!opa) continue;
    const key = String(record.P || "").trim().toLocaleUpperCase() + "\u0000" + opa;
    const current = latest.get(key);
    if (!current || activityTime(record) >= activityTime(current)) latest.set(key, record);
  }
  const now = Date.now();
  const updated = {
    records: [...latest.values(), ...withoutOpa],
    duplicateRecords,
    tableNames: Array.from(new Set([...(snapshot.tableNames || []), tableName])),
    revision: String(now) + "-" + Math.random().toString(36).slice(2),
    updatedAt: now,
  };
  globalThis.__dashboardRowsCache = { key: cacheKey, ...updated, expiresAt: now + 60_000 };
  if (cache) {
    try {
      await cache.put(dashboardCacheRequest(env), new Response(JSON.stringify(updated), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
      }));
      await writeSharedDashboardMetadata(cache, env, updated);
      await cache.put(dashboardCacheRequest(env, "revision"), new Response(JSON.stringify({ revision: updated.revision, updatedAt: now }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
      }));
    } catch (_) {}
  }
  // La copia de Cache API es la ruta rápida para el polling. La copia durable
  // se renueva en el escaneo periódico para evitar escribir R2 en cada edición.
  return true;
}

async function invalidateDashboardSnapshot(env) {
  const cacheKey = dashboardDataCacheKey(env);
  const local = globalThis.__dashboardRowsCache;
  if (local?.key === cacheKey) local.expiresAt = 0;

  const searchCache = globalThis.__dashboardOpaSearchCache;
  const searchPrefix = cacheKey + "|";
  if (searchCache) for (const key of searchCache.keys()) if (key.startsWith(searchPrefix)) searchCache.delete(key);

  const sharedCache = getSharedDashboardCache(env);
  if (!sharedCache) return;
  // Mark the snapshot stale without deleting it: all clients can keep reading
  // the last usable copy while one request rebuilds it in the background.
  const updatedAt = Date.now();
  const revision = `${updatedAt}-${Math.random().toString(36).slice(2)}`;
  try {
    await sharedCache.put(dashboardCacheRequest(env, "revision"), new Response(JSON.stringify({ revision, updatedAt }), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    }));
  } catch (_) {}
}

async function resolveTableColumnNames(env, tableName, values, skipMissing = false) {
  const cacheKey = String(env.SEATABLE_BASE_UUID || "");
  const now = Date.now();
  let cached = globalThis.__seatableMetadataCache;
  if (!cached || cached.key !== cacheKey || cached.expiresAt <= now) {
    const token = await getBaseToken(env);
    const url = `${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api-gateway/api/v2/dtables/${encodeURIComponent(cacheKey)}/metadata/`;
    const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }, 10_000);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`No se pudo verificar los nombres de columnas en SeaTable (HTTP ${response.status}).`);
    const tables = body.metadata?.tables || body.tables || [];
    cached = { key: cacheKey, tables, expiresAt: now + 60_000 };
    globalThis.__seatableMetadataCache = cached;
  }
  const table = cached.tables.find((item) => item.name === tableName);
  if (!table || !Array.isArray(table.columns)) return values;
  const actualNames = new Map(table.columns.map((column) => [normalizeHeader(column.name), column.name]));
  const resolved = {};
  for (const [columnName, value] of Object.entries(values)) {
    const actualName = actualNames.get(normalizeHeader(columnName));
    if (!actualName) {
      if (skipMissing) continue;
      throw new Error(`No se encontró la columna "${columnName}" en la hoja "${tableName}"; no se guardaron los cambios.`);
    }
    resolved[actualName] = value;
  }
  return resolved;
}

export async function getDashboardColumnType(env, tableName, columnName) {
  const cacheKey = String(env.SEATABLE_BASE_UUID || "");
  let metadata = globalThis.__seatableMetadataCache;
  if (!metadata || metadata.key !== cacheKey || metadata.expiresAt <= Date.now()) {
    const token = await getBaseToken(env);
    const url = `${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api-gateway/api/v2/dtables/${encodeURIComponent(cacheKey)}/metadata/`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`No se pudo verificar la columna de imágenes en SeaTable (HTTP ${response.status}).`);
    metadata = { key: cacheKey, tables: body.metadata?.tables || body.tables || [], expiresAt: Date.now() + 60_000 };
    globalThis.__seatableMetadataCache = metadata;
  }
  const tables = metadata.tables || [];
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
  const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }, 10_000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`No se pudo leer la fila seleccionada en SeaTable (HTTP ${response.status}).`);
  return body.row || body;
}

export async function getDashboardFileDownloadLink(env, path) {
  const cacheKey = `${env.SEATABLE_BASE_UUID || ""}|${String(path || "")}`;
  const now = Date.now();
  const linkCache = globalThis.__dashboardImageLinkCache || (globalThis.__dashboardImageLinkCache = new Map());
  const cachedLink = linkCache.get(cacheKey);
  if (cachedLink?.promise) return cachedLink.promise;
  if (cachedLink?.expiresAt > now) return cachedLink.link;
  const authBaseMatchesDashboard = !env.SEATABLE_AUTH_BASE_UUID || env.SEATABLE_AUTH_BASE_UUID === env.SEATABLE_BASE_UUID;
  const apiToken = authBaseMatchesDashboard && env.SEATABLE_AUTH_API_TOKEN ? env.SEATABLE_AUTH_API_TOKEN : env.SEATABLE_API_TOKEN;
  if (!apiToken) throw new Error("Falta configurar el API token de SeaTable para mostrar imágenes.");
  const url = new URL(`${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api/v2.1/dtable/app-download-link/`);
  url.searchParams.set("path", path);
  const promise = (async () => {
    // Las vistas previas no deben mantener abierta la carga de archivos si
    // SeaTable tarda en generar un enlace temporal.
    const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" } }, 6_000);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`SeaTable no pudo generar el enlace de la imagen (HTTP ${response.status}).`);
    const link = body.download_link || body.url || body.link;
    if (!link) throw new Error("SeaTable no devolvió el enlace temporal de la imagen.");
    // Los enlaces de descarga de SeaTable son temporales; un minuto evita
    // regenerarlos en cada render sin guardar una URL vencida demasiado tiempo.
    linkCache.set(cacheKey, { link, expiresAt: Date.now() + 60_000 });
    if (linkCache.size > 2_000) {
      const cleanupTime = Date.now();
      for (const [key, entry] of linkCache) {
        if (entry.expiresAt <= cleanupTime && !entry.promise) linkCache.delete(key);
        if (linkCache.size <= 1_500) break;
      }
    }
    return link;
  })();
  linkCache.set(cacheKey, { promise, expiresAt: now + 30_000 });
  try { return await promise; }
  catch (error) { linkCache.delete(cacheKey); throw error; }
}

export async function refreshForNewTables(env, context = null, { forceRefresh = false } = {}) {
  let cached = globalThis.__dashboardRowsCache;
  const cacheKey = dashboardDataCacheKey(env);
  const sharedCache = getSharedDashboardCache(env);
  const shared = sharedCache ? await readSharedDashboardSnapshot(sharedCache, dashboardCacheRequest(env)) : null;

  if (shared) {
    const revision = await readDashboardSnapshotRevision(sharedCache, env);
    globalThis.__dashboardRowsCache = { key: cacheKey, records: shared.records, duplicateRecords: shared.duplicateRecords || shared.records, tableNames: shared.tableNames, revision: shared.revision || "", updatedAt: shared.updatedAt, expiresAt: Date.now() + 60_000 };

    // Mutations and periodic refreshes only mark the snapshot stale. Return it
    // now, then let Pages finish the full SeaTable scan after the response.
    const ageMs = Date.now() - Number(shared.updatedAt || 0);
    const changedWhileEditing = String(shared.revision || "") !== revision;
    // Bound refresh frequency independently of the number of writes. This lets
    // the snapshot advance during continuous team activity without launching a
    // full-table scan for each individual save; direct SeaTable edits are still
    // reconciled by the periodic snapshot refresh.
    const isStale = forceRefresh || ageMs >= DASHBOARD_SNAPSHOT_MAX_AGE_MS || changedWhileEditing;
    const lock = await sharedCache.match(dashboardCacheRequest(env, "refresh-lock"));
    if (isStale && !lock && context && typeof context.waitUntil === "function") {
      // Usar el mismo lease compartido que el checksum evita que varias
      // solicitudes de usuarios distintos inicien escaneos completos a la vez.
      await scheduleDashboardBackgroundRefresh(env, context, sharedCache, cacheKey);
    }
    return { records: shared.records, updatedAt: Number(shared.updatedAt || 0), refreshing: isStale };
  }

  // La memoria del isolate y Cache API pueden estar vacías en una región nueva.
  // R2 conserva la última copia completa y permite responder de inmediato.
  if (!cached || cached.key !== cacheKey) {
    const durable = await readDurableDashboardSnapshot(env);
    if (durable) {
      cached = {
        key: cacheKey, records: durable.records, tableNames: durable.tableNames,
        revision: durable.revision || "", updatedAt: Number(durable.updatedAt || 0),
        expiresAt: Date.now() + 60_000,
      };
      globalThis.__dashboardRowsCache = cached;
      if (sharedCache) {
        try {
          await sharedCache.put(dashboardCacheRequest(env), new Response(JSON.stringify({
            records: cached.records, duplicateRecords: cached.duplicateRecords || cached.records, tableNames: cached.tableNames, revision: cached.revision, updatedAt: cached.updatedAt,
          }), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" } }));
        } catch (_) {}
      }
    }
  }

  // A Cache API snapshot can be absent in a newly routed isolate/colo even
  // though this isolate already has usable rows. Keep those rows visible and
  // refresh them in the background instead of blocking the user's request.
  if (cached?.key === cacheKey) {
    const ageMs = Date.now() - Number(cached.updatedAt || 0);
    const isStale = forceRefresh || ageMs >= DASHBOARD_SNAPSHOT_MAX_AGE_MS;
    if (isStale && context && typeof context.waitUntil === "function") {
      await scheduleDashboardBackgroundRefresh(env, context, sharedCache, cacheKey);
    }
    return { records: cached.records, updatedAt: Number(cached.updatedAt || 0), refreshing: isStale };
  }

  // Cold start for a region with no shared or isolate snapshot: one full read
  // is still required to produce the initial data set.
  const records = await loadDashboardRecords(env);
  return { records, updatedAt: Number(globalThis.__dashboardRowsCache?.updatedAt || Date.now()), refreshing: false };
}




