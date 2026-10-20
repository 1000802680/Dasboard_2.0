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

async function fetchAllRows(env) {
  assertConfig(env);
  const token = await getBaseToken(env);
  const server = env.SEATABLE_SERVER_URL.replace(/\/$/, "");
  const baseId = encodeURIComponent(env.SEATABLE_BASE_UUID);
  const all = [];
  let tableNames;
  if (env.SEATABLE_TABLE_NAMES) {
    tableNames = env.SEATABLE_TABLE_NAMES.split(",").map((name) => name.trim()).filter(Boolean);
  } else {
    const metadataUrl = `${server}/api-gateway/api/v2/dtables/${baseId}/metadata/`;
    const metadataResponse = await fetch(metadataUrl, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const metadataBody = await metadataResponse.json().catch(() => ({}));
    if (!metadataResponse.ok) throw new Error(`No se pudo leer la lista de tablas de SeaTable (HTTP ${metadataResponse.status}).`);
    tableNames = (metadataBody.metadata?.tables || metadataBody.tables || []).map((table) => table.name).filter(Boolean);
  }
  const systemTables = new Set(["USUARIOS", "HISTORIAL_AUDITORIA"]);
  tableNames = tableNames.filter((name) => !systemTables.has(normalizeHeader(name)));
  if (!tableNames.length) throw new Error("No se encontraron tablas en la base SeaTable. Revisa permisos y configuración.");

  const pageSize = 1000;
  for (const tableName of tableNames) {
    for (let start = 0; ; start += pageSize) {
      const url = new URL(`${server}/api-gateway/api/v2/dtables/${baseId}/rows/`);
      url.searchParams.set("table_name", tableName);
      url.searchParams.set("start", String(start));
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("convert_keys", "true");
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Error leyendo la tabla "${tableName}" de SeaTable (HTTP ${response.status}).`);
      const rows = Array.isArray(body) ? body : (body.rows || body.results || []);
      all.push(...rows.map((row) => ({ ...row, __table_name: tableName })));
      if (rows.length < pageSize) break;
      if (all.length >= 100_000) throw new Error("La lectura supera el tope de seguridad de 100.000 filas. Usa vistas o consulta por páginas/filtros.");
    }
  }
  return all;
}

function toInternalRecord(row, columns) {
  const byNormalizedName = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  const result = { H: row.__table_name || "SeaTable" };
  for (const [internal, external] of Object.entries(columns)) {
    const value = byNormalizedName.get(normalizeHeader(external));
    if (["MR", "ME"].includes(internal)) result[internal] = Number(value) || 0;
    else if (["F", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "FM"].includes(internal)) result[internal] = normalizeDate(value);
    else result[internal] = value == null ? "" : String(value).trim();
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
  return [...latest.values(), ...withoutOPA].map(({ _mtime, ...record }) => record);
}

function activityTime(record) {
  if (!record) return 0;
  const stageDates = [record.F8, record.F7, record.F6, record.F5, record.F4, record.F3, record.F2, record.F1, record.FM, record.F];
  const latestStage = stageDates.filter(Boolean).map((value) => Date.parse(value) || 0).reduce((max, value) => Math.max(max, value), 0);
  return latestStage || Date.parse(record._mtime || "") || 0;
}

export async function loadDashboardRecords(env, { forceRefresh = false } = {}) {
  const cacheKey = [env.SEATABLE_BASE_UUID, env.SEATABLE_TABLE_NAMES || "*", env.SEATABLE_COLUMN_MAP || "default"].join("|");
  const now = Date.now();
  const cached = globalThis.__dashboardRowsCache;
  if (!forceRefresh && cached?.key === cacheKey && cached.expiresAt > now) return cached.records;

  const columnMap = getColumnMap(env);
  const rows = await fetchAllRows(env);
  const records = rows.map((row) => toInternalRecord(row, columnMap));
  const uniqueRecords = deduplicateLatestOPA(records);
  globalThis.__dashboardRowsCache = { key: cacheKey, records: uniqueRecords, expiresAt: now + 30_000 };
  return uniqueRecords;
}

