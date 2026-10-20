const USERS_TABLE = "USUARIOS";
const AUDIT_TABLE = "HISTORIAL_AUDITORIA";
const USER_COLUMNS = [
  "ID_USUARIO", "USERNAME", "NOMBRE_COMPLETO", "ROL", "HASH_PWD", "SALT",
  "FECHA_REGISTRO_ISO", "ULTIMO_ACCESO_ISO", "CORREO", "PERMISOS_JSON",
];
const AUDIT_COLUMNS = [
  "TIMESTAMP_ISO", "FECHA_HORA_LOCAL", "USERNAME", "ROL", "TIPO_ACCION",
  "DETALLE_JSON", "OPA_AFECTADA", "HOJA_AFECTADA", "FILA_AFECTADA",
];
const DEFAULT_PERMISSIONS = {
  ver_dashboard: true,
  ver_analisis: true,
  ver_busqueda: true,
  cambiar_estado: false,
  panel_admin: false,
};
const ITERATIONS = 150_000;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

function authConfig(env) {
  // Por defecto, los usuarios viven en la misma base del dashboard y pueden
  // usar el token existente. Un token de autenticación separado sigue siendo
  // opcional para instalaciones que quieran aislar credenciales.
  const apiToken = env.SEATABLE_AUTH_API_TOKEN || env.SEATABLE_API_TOKEN;
  const missing = ["SEATABLE_SERVER_URL", "SEATABLE_BASE_UUID", "AUTH_SESSION_SECRET"]
    .filter((key) => !env[key]);
  if (!apiToken) missing.push("SEATABLE_API_TOKEN");
  if (missing.length) throw new Error(`Falta configurar autenticación: ${missing.join(", ")}.`);
  return {
    server: env.SEATABLE_SERVER_URL.replace(/\/$/, ""),
    base: encodeURIComponent(env.SEATABLE_AUTH_BASE_UUID || env.SEATABLE_BASE_UUID),
    token: apiToken,
  };
}

async function getAuthBaseToken(env) {
  const cfg = authConfig(env);
  const cache = globalThis.__authBaseToken;
  if (cache?.key === cfg.token && cache.expiresAt > Date.now() + 60_000) return cache.value;
  const response = await fetch(`${cfg.server}/api/v2.1/dtable/app-access-token/`, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`SeaTable rechazó el token de autenticación (HTTP ${response.status}).`);
  globalThis.__authBaseToken = { key: cfg.token, value: body.access_token, expiresAt: Date.now() + 2 * 24 * 60 * 60 * 1000 };
  return body.access_token;
}

async function requestTable(env, table, { method = "GET", start = 0, rows, updates } = {}) {
  const cfg = authConfig(env);
  const token = await getAuthBaseToken(env);
  const url = new URL(`${cfg.server}/api-gateway/api/v2/dtables/${cfg.base}/rows/`);
  url.searchParams.set("table_name", table);
  if (method === "GET") {
    url.searchParams.set("start", String(start));
    url.searchParams.set("limit", "1000");
    url.searchParams.set("convert_keys", "true");
  }
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(method === "GET" ? {} : { "Content-Type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(method === "POST" ? { table_name: table, rows } : { table_name: table, updates }) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(body.error_msg || body.error || body.detail || body.message || "").trim().slice(0, 240);
    const reason = detail ? ` Detalle de SeaTable: ${detail}` : "";
    throw new Error(`No se pudo acceder a la tabla ${table} (HTTP ${response.status}). Verifica que el UUID y el token correspondan a la misma base, que la tabla exista y que el token tenga permiso de lectura y escritura.${reason}`);
  }
  return body;
}

async function allRows(env, table) {
  const result = [];
  for (let start = 0; ; start += 1000) {
    const body = await requestTable(env, table, { start });
    const rows = Array.isArray(body) ? body : (body.rows || body.results || []);
    result.push(...rows);
    if (rows.length < 1000) return result;
    if (result.length >= 20_000) throw new Error(`La tabla ${table} supera el límite de seguridad de 20.000 filas.`);
  }
}

function normalizeUser(row) {
  const permissions = parsePermissions(row.PERMISOS_JSON, row.ROL);
  return {
    id: String(row.ID_USUARIO || row._id || ""),
    rowId: String(row._id || ""),
    username: String(row.USERNAME || "").trim(),
    nombreCompleto: String(row.NOMBRE_COMPLETO || ""),
    rol: String(row.ROL || "USUARIO").toUpperCase(),
    hashPwd: String(row.HASH_PWD || ""),
    salt: String(row.SALT || ""),
    fechaRegistro: String(row.FECHA_REGISTRO_ISO || ""),
    ultimoAcceso: String(row.ULTIMO_ACCESO_ISO || ""),
    correo: String(row.CORREO || ""),
    permisos: permissions,
  };
}

function parsePermissions(raw, role) {
  const defaults = { ...DEFAULT_PERMISSIONS, panel_admin: String(role || "").toUpperCase() === "ADMINISTRADOR" };
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
    return Object.fromEntries(Object.keys(defaults).map((key) => [key, typeof obj?.[key] === "boolean" ? obj[key] : defaults[key]]));
  } catch { return defaults; }
}

async function findUser(env, username) {
  const target = String(username || "").trim().toLocaleLowerCase();
  if (!target) return null;
  const rows = await allRows(env, USERS_TABLE);
  const row = rows.find((item) => String(item.USERNAME || "").trim().toLocaleLowerCase() === target);
  return row ? normalizeUser(row) : null;
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(text) {
  const padded = String(text).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function hmac(value, env) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.AUTH_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function makeSession(user, env) {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ sub: user.id, iat: Date.now(), exp: Date.now() + SESSION_LIFETIME_MS })));
  const signature = toBase64Url(await hmac(payload, env));
  return `${payload}.${signature}`;
}

async function authenticatedUser(token, env) {
  authConfig(env);
  if (!token || !env.AUTH_SESSION_SECRET) return null;
  const [payloadPart, signaturePart, extra] = String(token).split(".");
  if (!payloadPart || !signaturePart || extra) return null;
  const expected = await hmac(payloadPart, env);
  let received;
  try { received = fromBase64Url(signaturePart); } catch { return null; }
  if (expected.length !== received.length || expected.some((byte, i) => byte !== received[i])) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadPart))); } catch { return null; }
  if (!claims.sub || !Number.isFinite(claims.exp) || claims.exp <= Date.now()) return null;
  const rows = await allRows(env, USERS_TABLE);
  const row = rows.find((item) => String(item.ID_USUARIO || item._id || "") === String(claims.sub));
  if (!row) return null;
  return normalizeUser(row);
}

async function passwordDigest(hashPwd, salt, iterations = ITERATIONS) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(hashPwd)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations, hash: "SHA-256" }, material, 256);
  return toBase64Url(new Uint8Array(bits));
}

function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function addAudit(env, { username, role, action, detail = {}, opa = "", table = "", row = "" }) {
  const now = new Date();
  const record = {
    TIMESTAMP_ISO: now.toISOString(),
    FECHA_HORA_LOCAL: now.toLocaleString("es-CO", { timeZone: "America/Bogota" }),
    USERNAME: username || "ANONIMO",
    ROL: role || "USUARIO",
    TIPO_ACCION: action,
    DETALLE_JSON: JSON.stringify(detail),
    OPA_AFECTADA: opa,
    HOJA_AFECTADA: table,
    FILA_AFECTADA: row,
  };
  try { await requestTable(env, AUDIT_TABLE, { method: "POST", rows: [record] }); } catch (error) { console.error("No se pudo escribir auditoría:", error.message); }
}

function publicUser(user) {
  return {
    id: user.id, username: user.username, nombreCompleto: user.nombreCompleto,
    rol: user.rol, correo: user.correo, fechaRegistro: user.fechaRegistro,
    ultimoAcceso: user.ultimoAcceso, permisos: user.permisos,
  };
}

export async function getAuthenticatedUser(token, env) {
  try { return await authenticatedUser(token, env); } catch { return null; }
}

export async function handleAuthRequest(functionName, args, env) {
  authConfig(env);
  switch (functionName) {
    case "registerUser": {
      const p = args[0] || {};
      const username = String(p.username || "").trim();
      const passwordInput = String(p.hashPwd || "");
      if (username.length < 3 || !passwordInput) return { ok: false, error: "Ingresa usuario (mínimo 3 caracteres) y contraseña." };
      if (passwordInput.length < 20) return { ok: false, error: "Contraseña inválida. Intenta nuevamente." };
      if (await findUser(env, username)) return { ok: false, error: "Ese usuario ya existe." };
      const currentUsers = await allRows(env, USERS_TABLE);
      const adminExists = currentUsers.some((row) => String(row.ROL || "").toUpperCase() === "ADMINISTRADOR");
      let role = "USUARIO";
      if (!adminExists) {
        if (!env.AUTH_BOOTSTRAP_KEY || !safeEqual(p.bootstrapKey || "", env.AUTH_BOOTSTRAP_KEY)) {
          return { ok: false, error: "Para crear el primer administrador, ingresa la clave inicial configurada en Cloudflare." };
        }
        role = "ADMINISTRADOR";
      }
      const saltBytes = crypto.getRandomValues(new Uint8Array(18));
      const salt = toBase64Url(saltBytes);
      const hash = await passwordDigest(passwordInput, salt);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const permissions = { ...DEFAULT_PERMISSIONS, cambiar_estado: role === "ADMINISTRADOR", panel_admin: role === "ADMINISTRADOR" };
      await requestTable(env, USERS_TABLE, { method: "POST", rows: [{
        ID_USUARIO: id, USERNAME: username, NOMBRE_COMPLETO: String(p.nombreCompleto || "").trim(),
        ROL: role, HASH_PWD: `pbkdf2-sha256:${ITERATIONS}:${hash}`, SALT: salt,
        FECHA_REGISTRO_ISO: now, ULTIMO_ACCESO_ISO: "", CORREO: String(p.correo || "").trim(),
        PERMISOS_JSON: JSON.stringify(permissions),
      }] });
      await addAudit(env, { username, role, action: "REGISTRO_USUARIO" });
      return { ok: true, rol: role, username, nombreCompleto: String(p.nombreCompleto || ""), permisos: permissions, esPrimerUsuario: role === "ADMINISTRADOR", mensaje: role === "ADMINISTRADOR" ? "Cuenta administradora creada. Ya puedes iniciar sesión." : "Usuario creado correctamente. Ya puedes iniciar sesión." };
    }
    case "loginUser": {
      const p = args[0] || {};
      const username = String(p.username || "").trim();
      const user = await findUser(env, username);
      if (!user || !user.salt || !user.hashPwd) {
        await addAudit(env, { username, action: "LOGIN_FALLIDO", detail: { motivo: "credenciales_invalidas" } });
        return { ok: false, error: "Credenciales incorrectas." };
      }
      const match = user.hashPwd.match(/^pbkdf2-sha256:(\d+):(.+)$/);
      const check = await passwordDigest(p.hashPwd || "", user.salt, match ? Number(match[1]) : ITERATIONS);
      if (!match || !safeEqual(check, match[2])) {
        await addAudit(env, { username: user.username, role: user.rol, action: "LOGIN_FALLIDO", detail: { motivo: "credenciales_invalidas" } });
        return { ok: false, error: "Credenciales incorrectas." };
      }
      const token = await makeSession(user, env);
      const updatedAt = new Date().toISOString();
      await requestTable(env, USERS_TABLE, { method: "PUT", updates: [{ row_id: user.rowId, row: { ULTIMO_ACCESO_ISO: updatedAt } }] });
      await addAudit(env, { username: user.username, role: user.rol, action: "LOGIN_OK" });
      return { ok: true, token, username: user.username, nombreCompleto: user.nombreCompleto, rol: user.rol, correo: user.correo, permisos: user.permisos };
    }
    case "getCurrentUser": {
      const user = await authenticatedUser(args[0], env);
      return user ? { ok: true, logueado: true, ...publicUser(user), token: args[0] } : { ok: false, logueado: false, mensaje: "Sesión inválida o vencida." };
    }
    case "logoutUser":
      return { ok: true };
    case "adminListarUsuarios":
    case "adminListarPermisos": {
      const admin = await requireAdmin(args[0], env);
      if (admin.error) return { ok: false, error: admin.error };
      const users = (await allRows(env, USERS_TABLE)).map(normalizeUser).filter((user) => user.username);
      return { ok: true, listado: users.map(publicUser) };
    }
    case "adminGuardarPermisos": {
      const admin = await requireAdmin(args[0], env);
      if (admin.error) return { ok: false, error: admin.error };
      const target = String(args[1] || "").trim().toLocaleLowerCase();
      const users = await allRows(env, USERS_TABLE);
      const row = users.find((item) => String(item.USERNAME || "").trim().toLocaleLowerCase() === target);
      if (!row) return { ok: false, error: "Usuario no encontrado." };
      const role = String(row.ROL || "USUARIO").toUpperCase();
      const defaults = { ...DEFAULT_PERMISSIONS, panel_admin: role === "ADMINISTRADOR", cambiar_estado: role === "ADMINISTRADOR" };
      const input = args[2] && typeof args[2] === "object" ? args[2] : {};
      const permissions = Object.fromEntries(Object.keys(defaults).map((key) => [key, typeof input[key] === "boolean" ? input[key] : defaults[key]]));
      if (role === "ADMINISTRADOR") permissions.panel_admin = true;
      await requestTable(env, USERS_TABLE, { method: "PUT", updates: [{ row_id: row._id, row: { PERMISOS_JSON: JSON.stringify(permissions) } }] });
      await addAudit(env, { username: admin.username, role: admin.rol, action: "CAMBIO_PERMISOS", detail: { usuario_objetivo: row.USERNAME, permisos: permissions } });
      return { ok: true, username: row.USERNAME, permisos: permissions };
    }
    case "adminListarHistorial": {
      const admin = await requireAdmin(args[0], env);
      if (admin.error) return { ok: false, error: admin.error };
      const rows = await allRows(env, AUDIT_TABLE);
      const limit = Math.max(20, Math.min(Number(args[1]) || 500, 2000));
      return { ok: true, listado: rows.slice(-limit).reverse().map(toAuditRecord) };
    }
    case "adminObtenerHistorialYEstadisticas": {
      const admin = await requireAdmin(args[0], env);
      if (admin.error) return { ok: false, error: admin.error };
      const users = (await allRows(env, USERS_TABLE)).map(normalizeUser).filter((user) => user.username);
      const audit = (await allRows(env, AUDIT_TABLE)).slice(-3000).reverse().map(toAuditRecord);
      const stats = new Map();
      for (const user of users) stats.set(user.username, { username: user.username, nombreCompleto: user.nombreCompleto, rol: user.rol, correo: user.correo, fechaRegistro: user.fechaRegistro, ultimoAcceso: user.ultimoAcceso, totalAcciones: 0, cambioEstado: 0, editarCampo: 0, loginOk: 0, loginFallido: 0, cambioPermisos: 0, registroUsuario: 0, otras: 0, opas: new Set() });
      for (const item of audit) {
        const stat = stats.get(item.username) || { username: item.username, nombreCompleto: "", rol: item.rol || "USUARIO", correo: "", fechaRegistro: "", ultimoAcceso: "", totalAcciones: 0, cambioEstado: 0, editarCampo: 0, loginOk: 0, loginFallido: 0, cambioPermisos: 0, registroUsuario: 0, otras: 0, opas: new Set() };
        stat.totalAcciones++;
        const field = ({ CAMBIO_ESTADO: "cambioEstado", EDITAR_CAMPO: "editarCampo", LOGIN_OK: "loginOk", LOGIN_FALLIDO: "loginFallido", CAMBIO_PERMISOS: "cambioPermisos", REGISTRO_USUARIO: "registroUsuario" })[item.tipoAccion] || "otras";
        stat[field]++;
        if (item.opaAfectada) stat.opas.add(item.opaAfectada);
        stats.set(item.username, stat);
      }
      const resumenUsuarios = [...stats.values()].map(({ opas, ...item }) => ({ ...item, opasUnicasTocadas: opas.size })).sort((a, b) => b.totalAcciones - a.totalAcciones);
      const totalCambiosEstado = resumenUsuarios.reduce((sum, item) => sum + item.cambioEstado, 0);
      const totalEdicionesCampo = resumenUsuarios.reduce((sum, item) => sum + item.editarCampo, 0);
      return { ok: true, resumenUsuarios, listado: audit, totalesGlobales: { totalUsuariosRegistrados: users.length, totalAccionesSistema: audit.length, totalCambiosEstado, totalEdicionesCampo, totalOPAsTocadas: new Set(audit.map((item) => item.opaAfectada).filter(Boolean)).size } };
    }
    default:
      return { ok: false, error: `La función ${functionName} no está disponible en autenticación.` };
  }
}

async function requireAdmin(token, env) {
  const user = await authenticatedUser(token, env);
  return user && (user.rol === "ADMINISTRADOR" || user.permisos.panel_admin) ? user : { error: "Acceso denegado. Solo administrador." };
}

function toAuditRecord(row) {
  return {
    tsISO: String(row.TIMESTAMP_ISO || ""), tsLocal: String(row.FECHA_HORA_LOCAL || ""),
    username: String(row.USERNAME || ""), rol: String(row.ROL || ""), tipoAccion: String(row.TIPO_ACCION || ""),
    detalleJSON: String(row.DETALLE_JSON || ""), opaAfectada: String(row.OPA_AFECTADA || ""),
    hojaAfectada: String(row.HOJA_AFECTADA || ""), filaAfectada: String(row.FILA_AFECTADA || ""),
  };
}

export const AUTH_TABLE_COLUMNS = { users: USER_COLUMNS, audit: AUDIT_COLUMNS };
