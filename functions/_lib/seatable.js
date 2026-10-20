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

async function getBaseToken(env) {
  const now = Date.now();
  if (globalThis.__seatableToken?.expiresAt > now + 60_000) return globalThis.__seatableToken.value;

  const response = await fetch(`${env.SEATABLE_SERVER_URL.replace(/\/$/, "")}/api/v2.1/dtable/app-access-token/`, {
    headers: { Authorization: `Bearer ${env.SEATABLE_API_TOKEN}`, Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`SeaTable no entregó un token de base (HTTP ${response.status}). Revisa URL y API token.`);
  }
  globalThis.__seatableToken = { value: body.access_token, expiresAt: now + 2 * 24 * 60 * 60 * 1000 };
  return body.access_token;
}

function assertConfig(env) {
  const missing = ["SEATABLE_SERVER_URL", "SEATABLE_API_TOKEN", "SEATABLE_BASE_UUID"]
    .filter((key) => !env[key]);
  if (missing.length) throw new Error(`Falta configurar: ${missing.join(", ")}.`);
}

async function discoverTableNames(env, token) {
  const server = env.SEATABLE_SERVER_URL.replace(/\/$/, "");
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  const metadataUrl = `${server}/api-gateway/api/v2/dtables/${baseId}/metadata/`;
  const metadataResponse = await fetch(metadataUrl, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const metadataBody = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok) throw new Error(`No se pudo leer la lista de pestañas de SeaTable (HTTP ${metadataResponse.status}).`);
  const tables = metadataBody.metadata?.tables || metadataBody.tables || [];
  const names = tables.map((table) => table.name).filter(Boolean);
  if (!names.length) throw new Error("SeaTable no devolvió pestañas. Verifica el UUID y los permisos del token.");
  return [...new Set(names)].filter((name) => !["USUARIOS", "HISTORIAL_AUDITORIA"].includes(normalizeHeader(name)));
}

async function forEachSeaTableRow(env, onRow, knownTableNames = null) {
  assertConfig(env);
  const token = await getBaseToken(env);
  const server = env.SEATABLE_SERVER_URL.replace(/\/$/, "");
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  const tableNames = knownTableNames || await discoverTableNames(env, token);
  if (!tableNames.length) throw new Error("No se encontraron tablas en la base SeaTable. Revisa permisos y configuración.");

  const pageSize = 1000;
  for (const tableName of tableNames) {
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
      for (const row of rows) onRow(row, tableName);
      if (rows.length < pageSize) break;
      if (start + rows.length >= 100_000) throw new Error("La lectura supera el tope de seguridad de 100.000 filas. Usa vistas o consulta por páginas/filtros.");
    }
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
    if (internal === "MR" || internal === "ME") result[internal] = Number(value) || 0;
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
    globalThis.__dashboardRowsCache = { key: cacheKey, records, tableNames: detectedTableNames, expiresAt: Date.now() + 30_000 };
    return records;
  })();
  globalThis.__dashboardRowsLoading = { key: cacheKey, promise };
  try { return await promise; }
  finally { if (globalThis.__dashboardRowsLoading?.promise === promise) globalThis.__dashboardRowsLoading = null; }
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

