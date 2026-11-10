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

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Tiempo de espera agotado")), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`SeaTable tardó más de ${Math.round(timeoutMs / 1000)} segundos en responder.`);
    throw error;
  } finally {
    clearTimeout(timer);
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

async function getBaseToken(env, apiToken = env.SEATABLE_API_TOKEN) {
  const now = Date.now();
  const cached = globalThis.__seatableToken;
  if (cached?.key === apiToken && cached.expiresAt > now + 60_000) return cached.value;

  const response = await fetchWithTimeout(`${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api/v2.1/dtable/app-access-token/`, {
    headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
  }, 10_000);
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
  const metadataCacheKey = String(env.SEATABLE_BASE_UUID || "");
  const cachedMetadata = globalThis.__seatableMetadataCache;
  if (cachedMetadata?.key === metadataCacheKey && cachedMetadata.expiresAt > Date.now() && Array.isArray(cachedMetadata.tables)) {
    return dashboardDataTableNames(cachedMetadata.tables);
  }
  const server = env.SEATABLE_SERVER_URL.replace(/\/$/, "");
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  token = token || await getBaseToken(env);
  const metadataUrl = `${server}/api-gateway/api/v2/dtables/${baseId}/metadata/`;
  const metadataResponse = await fetchWithTimeout(metadataUrl, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }, 10_000);
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
      if (env.SEATABLE_VIEW_NAME) url.searchParams.set("view_name", env.SEATABLE_VIEW_NAME);
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
    // SQL recupera hasta 10.000 filas por llamada frente al límite de 1.000
    // del endpoint de filas. Si SQL no está disponible, conserva compatibilidad.
    if (!env.SEATABLE_VIEW_NAME) {
      try { return await readTableWithSql(tableName); }
      catch (projectionError) {
        // Un timeout indica que SeaTable está lento; volver a pedir la misma
        // tabla por dos APIs distintas solo triplicaba la espera del usuario.
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
    return readTableWithRowsAPI(tableName);
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
  // Una actualización manual también comparte la lectura que ya esté en curso
  // dentro del mismo isolate, evitando que varios usuarios disparen el mismo scan.
  if (globalThis.__dashboardRowsLoading?.key === cacheKey) return globalThis.__dashboardRowsLoading.promise;

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
          globalThis.__dashboardRowsCache = { key: cacheKey, records: shared.records, tableNames: shared.tableNames, updatedAt: shared.updatedAt, expiresAt: Date.now() + 60_000 };
          return shared.records;
        } else {
          globalThis.__dashboardRowsCache = { key: cacheKey, records: shared.records, tableNames: shared.tableNames, updatedAt: shared.updatedAt, expiresAt: Date.now() + 60_000 };
          return shared.records;
        }
      } else {
        globalThis.__dashboardRowsCache = { key: cacheKey, records: shared.records, tableNames: shared.tableNames, updatedAt: shared.updatedAt, expiresAt: Date.now() + 60_000 };
        return shared.records;
      }
    }
  }
  if (sharedCache) {
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
        globalThis.__dashboardRowsCache = { key: cacheKey, records: refreshed.records, tableNames: refreshed.tableNames, updatedAt: refreshed.updatedAt, expiresAt: Date.now() + 60_000 };
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
    // Publish a completed scan even if a write happened during it. Keep the
    // older scanRevision on the snapshot so the next quiet-window refresh knows
    // it must catch up; discarding every scan during active work can starve the
    // shared cache forever when several people are editing at once.
    const updatedAt = Date.now();
    globalThis.__dashboardRowsCache = { key: cacheKey, records, tableNames: detectedTableNames, revision: scanRevision, updatedAt, expiresAt: updatedAt + 60_000 };
    if (sharedCache) {
      try {
        await sharedCache.put(sharedRequest, new Response(JSON.stringify({ records, tableNames: detectedTableNames, revision: scanRevision, updatedAt }), {
          // Keep a usable snapshot available while a newer scan runs. Freshness
          // is controlled by updatedAt/revision below, not by Cache API expiry.
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
        }));
      } catch (_) {}
    }
    return records;
  })().finally(async () => {
    if (ownsRefreshLease && sharedCache) {
      try { await sharedCache.delete(dashboardCacheRequest(env, "refresh-lock")); } catch (_) {}
    }
  });
  globalThis.__dashboardRowsLoading = { key: cacheKey, promise };
  try { return await promise; }
  finally { if (globalThis.__dashboardRowsLoading?.promise === promise) globalThis.__dashboardRowsLoading = null; }
}

// Reutiliza por unos segundos las búsquedas repetidas y comparte solicitudes
// simultáneas del mismo número dentro del mismo isolate.
export async function searchDashboardRecordsByOPA(env, query) {
  const key = [env.SEATABLE_BASE_UUID, env.SEATABLE_VIEW_NAME || "*", env.SEATABLE_COLUMN_MAP || "default", query].join("|");
  const now = Date.now();
  const cache = globalThis.__dashboardOpaSearchCache || (globalThis.__dashboardOpaSearchCache = new Map());
  const cached = cache.get(key);
  if (cached?.expiresAt > now) return cached.records;
  const pending = globalThis.__dashboardOpaSearchPending || (globalThis.__dashboardOpaSearchPending = new Map());
  if (pending.has(key)) return pending.get(key);
  const promise = searchDashboardRecordsByOPAUncached(env, query).then((records) => {
    cache.set(key, { records, expiresAt: Date.now() + 8_000 });
    if (cache.size > 300) {
      for (const [cacheKey, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(cacheKey);
      while (cache.size > 300) cache.delete(cache.keys().next().value);
    }
    return records;
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

// Busca una OPA exacta directamente en SeaTable cuando no hay un snapshot
// reciente. Evita descargar miles de filas solo para mostrar uno o pocos matches.
async function searchDashboardRecordsByOPAUncached(env, query) {
  const cacheKey = [env.SEATABLE_BASE_UUID, env.SEATABLE_VIEW_NAME || "*", env.SEATABLE_COLUMN_MAP || "default"].join("|");
  const now = Date.now();
  const local = globalThis.__dashboardRowsCache;
  // La API SQL consulta la tabla completa, no una vista concreta. Si el
  // dashboard está configurado con una vista, respetamos ese alcance existente.
  const sharedCache = getSharedDashboardCache(env);
  if (sharedCache) {
    const snapshot = await readSharedDashboardSnapshot(sharedCache, dashboardCacheRequest(env));
    if (snapshot) {
      globalThis.__dashboardRowsCache = { key: cacheKey, records: snapshot.records, tableNames: snapshot.tableNames, updatedAt: snapshot.updatedAt, expiresAt: Date.now() + 60_000 };
      return snapshot.records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
    }
  }
  // Solo usar el snapshot local cuando no hay caché compartida que pueda
  // señalar una invalidación hecha por otro isolate.
  if (!sharedCache && local?.key === cacheKey && local.expiresAt > now) {
    return local.records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
  }
  // SQL no aplica vistas. En ese caso respetamos la vista solo si ya existe
  // una copia compartida; evitamos descargar miles de filas por una búsqueda.
  if (env.SEATABLE_VIEW_NAME) {
    const localView = globalThis.__dashboardRowsCache;
    if (localView?.key === cacheKey && localView.records) return localView.records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
    throw new Error("La vista de SeaTable todavía no está cargada. Abre Dashboard o pulsa Actualizar datos y vuelve a buscar.");
  }

  if (sharedCache) {
    try {
      const response = await sharedCache.match(dashboardCacheRequest(env));
      if (response) {
        const snapshot = await response.json();
        if (Array.isArray(snapshot.records) && Array.isArray(snapshot.tableNames)) {
          globalThis.__dashboardRowsCache = { key: cacheKey, records: snapshot.records, tableNames: snapshot.tableNames, updatedAt: snapshot.updatedAt, expiresAt: Date.now() + 60_000 };
          return snapshot.records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
        }
      }
    } catch (_) {}
  }

  // If this isolate has a recent full read but the regional Cache API entry
  // is temporarily absent, serve the known copy instead of starting another
  // multi-table scan just to answer one exact OPA lookup.
  if (local?.key === cacheKey && Array.isArray(local.records)) {
    return local.records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
  }

  // Reutiliza los metadatos de las hojas ya consultados por el dashboard,
  // evitando otra petición de esquema cada vez que se busca una OPA.
  const tableNames = new Set(await discoverTableNames(env));
  const tables = (globalThis.__seatableMetadataCache?.tables || []).filter((table) => table.name && tableNames.has(table.name));
  const token = await getBaseToken(env);
  const server = env.SEATABLE_SERVER_URL.replace(/\/$/, "");
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  const opaColumnName = normalizeHeader(getColumnMap(env).O);
  const searchable = tables.map((table) => ({
    name: table.name,
    opaColumn: (table.columns || []).find((column) => normalizeHeader(column.name) === opaColumnName)?.name,
    columns: table.columns || [],
  })).filter((table) => table.opaColumn);
  const columnMap = getColumnMap(env);
  const resultsByTable = new Map();
  let next = 0;
  const controller = new AbortController();
  let deadlineTimer;
  async function searchTable(table) {
    const quote = (identifier) => `\`${String(identifier).replace(/`/g, "``")}\``;
    const selectedColumns = new Set(["_id"]);
    const availableByNormalized = new Map(table.columns.map((column) => [normalizeHeader(column.name), column.name]));
    for (const configuredName of Object.values(columnMap)) {
      const actualName = availableByNormalized.get(normalizeHeader(configuredName));
      if (actualName) selectedColumns.add(actualName);
    }
    const projection = [...selectedColumns].map(quote).join(", ");
    const response = await fetch(`${server}/api-gateway/api/v2/dtables/${baseId}/sql/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: `SELECT ${projection} FROM ${quote(table.name)} WHERE ${quote(table.opaColumn)} = ? LIMIT 10000`,
        parameters: [query],
        convert_keys: true,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`SeaTable no pudo buscar la OPA en "${table.name}" (HTTP ${response.status}).`);
    const rows = Array.isArray(body) ? body : [body.results, body.rows, body.data].find(Array.isArray);
    if (!Array.isArray(rows)) throw new Error(`SeaTable devolvió un formato inesperado al buscar en "${table.name}".`);
    const records = [];
    for (const row of rows) {
      // Garantiza coincidencia completa incluso si el motor convierte tipos.
      const opaKey = Object.keys(row).find((key) => normalizeHeader(key) === normalizeHeader(table.opaColumn));
      if (String(opaKey ? row[opaKey] : "").trim().toLocaleLowerCase() !== query) continue;
      records.push(toInternalRecord(row, table.name, getSourceKeyMap(row, columnMap)));
    }
    resultsByTable.set(table.name, records);
  }
  const concurrency = Math.min(10, searchable.length);
  async function worker() {
    while (next < searchable.length) await searchTable(searchable[next++]);
  }
  try {
    // Un límite global evita que la búsqueda quede girando mientras se espera
    // a una hoja lenta. La búsqueda directa reemplaza el fallback de escanear
    // todas las filas (que podía tardar 50 s o más).
    await Promise.race([
      Promise.all(Array.from({ length: concurrency }, () => worker())),
      new Promise((_, reject) => { deadlineTimer = setTimeout(() => { controller.abort(); reject(new Error("La búsqueda en SeaTable superó 10 segundos. Revisa la conexión o intenta de nuevo.")); }, 10_000); }),
    ]);
  } catch (error) {
    controller.abort();
    // Si hay una copia previa, mostrarla en lugar de dejar la consulta colgada.
    const localStale = globalThis.__dashboardRowsCache;
    if (localStale?.key === cacheKey && Array.isArray(localStale.records)) {
      return localStale.records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
    }
    if (sharedCache) {
      const stale = await readSharedDashboardSnapshot(sharedCache, dashboardCacheRequest(env));
      if (stale) return stale.records.filter((record) => String(record.O || "").trim().toLocaleLowerCase() === query);
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
  return searchable.flatMap((table) => resultsByTable.get(table.name) || []).sort((a, b) => activityTime(b).localeCompare(activityTime(a)));
}

function getSharedDashboardCache(env) {
  try { return typeof caches !== "undefined" && caches.default ? caches.default : null; }
  catch (_) { return null; }
}

function dashboardCacheRequest(env, suffix = "snapshot") {
  const key = [env.SEATABLE_BASE_UUID, env.SEATABLE_VIEW_NAME || "*", env.SEATABLE_COLUMN_MAP || "default"].join("|");
  return new Request(`https://dashboard-cache.invalid/v1/${encodeURIComponent(key)}/${suffix}`);
}

async function readSharedDashboardSnapshot(cache, request) {
  try {
    const response = await cache.match(request);
    if (!response) return null;
    const snapshot = await response.json();
    return Array.isArray(snapshot.records) && Array.isArray(snapshot.tableNames) ? snapshot : null;
  } catch (_) { return null; }
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

export async function updateDashboardRow(env, tableName, rowId, values) {
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
  await invalidateDashboardSnapshot(env);
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
  await invalidateDashboardSnapshot(env);
  return body;
}

async function invalidateDashboardSnapshot(env) {
  const cacheKey = [env.SEATABLE_BASE_UUID, env.SEATABLE_VIEW_NAME || "*", env.SEATABLE_COLUMN_MAP || "default"].join("|");
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
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" } });
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

export async function refreshForNewTables(env, context = null) {
  const cached = globalThis.__dashboardRowsCache;
  const cacheKey = [env.SEATABLE_BASE_UUID, env.SEATABLE_VIEW_NAME || "*", env.SEATABLE_COLUMN_MAP || "default"].join("|");
  const sharedCache = getSharedDashboardCache(env);
  const shared = sharedCache ? await readSharedDashboardSnapshot(sharedCache, dashboardCacheRequest(env)) : null;

  if (shared) {
    const revision = await readDashboardSnapshotRevision(sharedCache, env);
    globalThis.__dashboardRowsCache = { key: cacheKey, records: shared.records, tableNames: shared.tableNames, revision: shared.revision || "", updatedAt: shared.updatedAt, expiresAt: Date.now() + 60_000 };

    // Mutations and periodic refreshes only mark the snapshot stale. Return it
    // now, then let Pages finish the full SeaTable scan after the response.
    const ageMs = Date.now() - Number(shared.updatedAt || 0);
    const changedWhileEditing = String(shared.revision || "") !== revision;
    // Bound refresh frequency independently of the number of writes. This lets
    // the snapshot advance during continuous team activity without launching a
    // full-table scan for each individual save; direct SeaTable edits are still
    // caught by the 60 second periodic refresh.
    const isStale = ageMs >= 60_000 || (changedWhileEditing && ageMs >= 30_000);
    const lock = await sharedCache.match(dashboardCacheRequest(env, "refresh-lock"));
    if (isStale && !lock && context && typeof context.waitUntil === "function") {
      const pending = globalThis.__dashboardBackgroundRefresh;
      if (pending?.key === cacheKey) context.waitUntil(pending.promise);
      else {
        const promise = loadDashboardRecords(env, { forceRefresh: true })
          .catch((error) => console.warn("Dashboard background refresh failed:", error?.message || error));
        globalThis.__dashboardBackgroundRefresh = { key: cacheKey, promise };
        context.waitUntil(promise.finally(() => {
          if (globalThis.__dashboardBackgroundRefresh?.promise === promise) globalThis.__dashboardBackgroundRefresh = null;
        }));
      }
    }
    return { records: shared.records, updatedAt: Number(shared.updatedAt || 0), refreshing: isStale };
  }

  // Cold start for a region with no shared snapshot: a full read is necessary
  // once; later requests use stale-while-revalidate above.
  if (cached?.key === cacheKey) cached.expiresAt = 0;
  const records = await loadDashboardRecords(env);
  return { records, updatedAt: Number(globalThis.__dashboardRowsCache?.updatedAt || Date.now()), refreshing: false };
}




