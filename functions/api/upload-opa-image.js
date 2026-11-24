import { discoverTableNames, getDashboardColumnName, getDashboardColumnType, getDashboardFileDownloadLink, getDashboardRow, getDashboardWorkspaceId, loadDashboardRecords, updateDashboardRow } from "../_lib/seatable.js";
import { getAuthenticatedUser, recordBusinessAudit } from "../_lib/auth.js";

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const form = await request.formData();
    const user = await getAuthenticatedUser(String(form.get("token") || ""), env);
    if (!user) return json({ ok: false, error: "Inicia sesión para adjuntar imágenes." }, 401);
    if (user.permisos?.cambiar_estado === false) return json({ ok: false, error: "No tienes permiso para editar esta OPA." }, 403);

    const tableName = String(form.get("table") || "").trim();
    const rowId = String(form.get("rowId") || "").trim();
    const columnKey = String(form.get("columnKey") || "LF").trim().toUpperCase();
    const isNewRow = String(form.get("newRow") || "") === "1";
    if (!["LF", "GE"].includes(columnKey)) return json({ ok: false, error: "Solo puedes adjuntar fotos del producto o de la guía de envío." }, 400);
    if (!tableName || !rowId) return json({ ok: false, error: "Falta identificar la hoja y la fila de la OPA." }, 400);
    if (!(await discoverTableNames(env)).includes(tableName)) return json({ ok: false, error: "La hoja indicada no pertenece a las hojas de datos del dashboard." }, 400);

    const action = String(form.get("action") || "upload").trim().toLowerCase();
    if (action === "delete") return await removeAttachedImage(context, env, user, form, tableName, rowId, columnKey);
    if (action !== "upload") return json({ ok: false, error: "La acción solicitada no está permitida." }, 400);

    const files = form.getAll("files").filter((item) => item && typeof item.arrayBuffer === "function" && item.size > 0);
    if (!files.length) return json({ ok: false, error: "Selecciona al menos una imagen." }, 400);
    if (files.length > MAX_IMAGES) return json({ ok: false, error: `Puedes subir hasta ${MAX_IMAGES} imágenes por vez.` }, 413);
    for (const file of files) {
      if (!ALLOWED_TYPES.has(String(file.type || "").toLowerCase())) return json({ ok: false, error: `El archivo "${file.name}" no es JPG, PNG, WEBP o GIF.` }, 415);
      if (file.size > MAX_IMAGE_BYTES) return json({ ok: false, error: `Cada imagen debe pesar máximo 8 MB. Revisa "${file.name}".` }, 413);
    }

    const dashboardToken = env.SEATABLE_API_TOKEN;
    const authBaseMatchesDashboard = !env.SEATABLE_AUTH_BASE_UUID || env.SEATABLE_AUTH_BASE_UUID === env.SEATABLE_BASE_UUID;
    const apiToken = authBaseMatchesDashboard && env.SEATABLE_AUTH_API_TOKEN ? env.SEATABLE_AUTH_API_TOKEN : dashboardToken;
    if (!apiToken) throw new Error("Falta configurar el API token de SeaTable para subir imágenes.");

    const columnName = getDashboardColumnName(env, columnKey);
    const columnType = await getDashboardColumnType(env, tableName, columnName);
    let selectedRowId = rowId;
    let currentRow = {};
    if (!isNewRow) {
      try {
        currentRow = await getDashboardRow(env, tableName, selectedRowId);
      } catch (error) {
        if (!/HTTP 404/.test(String(error?.message || error))) throw error;
        const records = await loadDashboardRecords(env, { forceRefresh: true, includeDuplicates: true });
        let candidates = records.filter((record) =>
          String(record.H || "").trim() === tableName &&
          String(record.O || "").trim() === String(form.get("numeroOPA") || "").trim()
        );
        const identityFields = [
          ["P", form.get("proyecto")], ["T", form.get("tipoProducto")],
          ["TE", form.get("tipoProductoEspecifico")], ["TR", form.get("territorio")],
          ["SO", form.get("subOpa")], ["PJ", form.get("personaje")],
        ];
        const normalizeIdentity = (value) => String(value || "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleUpperCase().replace(/[^A-Z0-9]/g, "");
        for (const [key, value] of identityFields) {
          if (String(value || "").trim()) {
            const expected = normalizeIdentity(value);
            candidates = candidates.filter((record) => normalizeIdentity(record[key]) === expected);
          }
        }
        if (candidates.length !== 1 || !String(candidates[0]?._id || "").trim()) {
          return json({ ok: false, error: candidates.length
            ? `Hay varias filas indistinguibles para la OPA ${String(form.get("numeroOPA") || "")} en ${tableName}. Vuelve a buscar y elige el registro correcto.`
            : `La fila seleccionada ya no existe en SeaTable. Vuelve a buscar la OPA ${String(form.get("numeroOPA") || "")} y selecciona el registro actualizado.`
          }, 409);
        }
        currentRow = candidates[0];
        selectedRowId = String(currentRow._id);
      }
    }
    const normalizedColumnType = columnType.replace(/[\s_-]/g, "");
    const fileType = columnType === "image" ? "image" : columnType === "file" ? "file" : columnKey === "GE" && ["text", "longtext"].includes(normalizedColumnType) ? "text" : "";
    if (!fileType) return json({ ok: false, error: `La columna "${columnName}" debe ser de tipo Imagen o Archivo${columnKey === "GE" ? " o Texto largo" : ""} para guardar fotos.` }, 400);

    const server = env.SEATABLE_SERVER_URL.replace(/\/$/, "");
    const linkResponse = await fetch(`${server}/api/v2.1/dtable/app-upload-link/`, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
    });
    const uploadInfo = await linkResponse.json().catch(() => ({}));
    if (!linkResponse.ok || !uploadInfo.upload_link) throw new Error(`SeaTable no pudo preparar la carga de imágenes (HTTP ${linkResponse.status}).`);

    const relativePath = fileType === "image" ? uploadInfo.img_relative_path : uploadInfo.file_relative_path;
    const workspaceId = String(uploadInfo.workspace_id || await getDashboardWorkspaceId(env, apiToken));
    if (!relativePath || !uploadInfo.parent_path || !workspaceId) throw new Error("SeaTable devolvió datos incompletos para guardar la imagen.");
    const saved = [];
    for (const file of files) {
      const uploadForm = new FormData();
      uploadForm.append("file", file, file.name);
      uploadForm.append("parent_dir", uploadInfo.parent_path);
      uploadForm.append("relative_path", relativePath);
      uploadForm.append("replace", "0");
      const uploadUrl = new URL(uploadInfo.upload_link);
      uploadUrl.searchParams.set("ret-json", "1");
      const uploadResponse = await fetch(uploadUrl, { method: "POST", body: uploadForm, headers: { Accept: "application/json" } });
      const uploadText = await uploadResponse.text();
      let uploadBody = {};
      try { uploadBody = JSON.parse(uploadText); } catch (_) { uploadBody = uploadText; }
      // SeaTable responde con una lista cuando ret-json=1, incluso al subir un solo archivo.
      const uploaded = Array.isArray(uploadBody) ? uploadBody[0] : uploadBody;
      if (!uploadResponse.ok || !uploaded || !uploaded.name) {
        const detail = String(uploaded?.error || uploadBody?.error || uploadBody?.detail || (typeof uploadBody === "string" ? uploadBody : "")).trim().slice(0, 180);
        throw new Error(`SeaTable no pudo confirmar la carga de "${file.name}" (HTTP ${uploadResponse.status}).${detail ? ` ${detail}` : ""}`);
      }
      const uploadedName = String(uploaded.name);
      const relativeUrl = `/workspace/${workspaceId}${uploadInfo.parent_path}/${relativePath}/${uploadedName}`;
      saved.push({ name: uploadedName, size: file.size, path: relativeUrl, type: fileType });
    }

    const existingGuide = fileType === "text" ? normalizeTextGuide(currentRow[columnName]) : null;
    const requestedGuideLink = String(form.get("guideLink") || "").trim();
    const existing = fileType === "text" ? existingGuide.photos : normalizeExisting(currentRow[columnName], fileType);
    const merged = [...existing];
    for (const item of saved) {
      if (fileType === "image" || fileType === "text") merged.push(item.path);
      else merged.push({ name: item.name, size: item.size, type: "file", url: item.path });
    }
    const storedValue = fileType === "text" ? JSON.stringify({ version: 1, link: requestedGuideLink || existingGuide.link, photos: merged }) : merged;
    await updateDashboardRow(env, tableName, selectedRowId, { [columnName]: storedValue });
    const auditTask = recordBusinessAudit(env, {
      username: user.username, role: user.rol, action: columnKey === "GE" ? "ADJUNTAR_FOTOS_GUIA_ENVIO" : "ADJUNTAR_IMAGENES",
      detail: { columna: columnName, archivos: saved.map((item) => item.name) },
      opa: String(form.get("numeroOPA") || ""), table: tableName, row: selectedRowId,
    });
    if (typeof context?.waitUntil === "function") context.waitUntil(auditTask);
    else await auditTask;
    const images = await Promise.all(merged.map(async (item) => {
      const path = typeof item === "string" ? item : String(item.url || item.path || "");
      const name = typeof item === "string" ? item.split("/").pop() : item.name || path.split("/").pop();
      if (/^https?:\/\//i.test(path)) return { name, url: path, attachmentKey: path };
      try { return { name, url: await getDashboardFileDownloadLink(env, pathToImagePath(path)), attachmentKey: path }; }
      catch (_) { return { name, url: "", attachmentKey: path }; }
    }));
    return json({ ok: true, columna: columnKey, rowId: selectedRowId, imagenes: images, cantidad: saved.length, valorGuardado: storedValue, enlaceGuia: requestedGuideLink || existingGuide?.link || "", mensaje: `${saved.length} imagen${saved.length === 1 ? "" : "es"} guardada${saved.length === 1 ? "" : "s"} en ${columnName}.` });
  } catch (error) {
    return json({ ok: false, error: error.message || "No se pudieron subir las imágenes." }, 502);
  }
}


async function removeAttachedImage(context, env, user, form, tableName, rowId, columnKey) {
  const targetKey = String(form.get("attachmentKey") || "").trim();
  if (!targetKey) return json({ ok: false, error: "Selecciona la foto que quieres eliminar." }, 400);

  const columnName = getDashboardColumnName(env, columnKey);
  const [columnType, currentRow] = await Promise.all([
    getDashboardColumnType(env, tableName, columnName),
    getDashboardRow(env, tableName, rowId),
  ]);
  const normalizedColumnType = columnType.replace(/[\\s_-]/g, "");
  const fileType = columnType === "image" ? "image" : columnType === "file" ? "file" : columnKey === "GE" && ["text", "longtext"].includes(normalizedColumnType) ? "text" : "";
  if (!fileType) return json({ ok: false, error: "La columna no permite eliminar fotos desde esta vista." }, 400);

  const existingValue = currentRow[columnName] ?? currentRow[columnKey];
  const existingGuide = fileType === "text" ? normalizeTextGuide(existingValue) : null;
  const attachments = fileType === "text" ? existingGuide.photos : normalizeExisting(existingValue, fileType);
  const getAttachmentKey = (item) => typeof item === "string" ? item.trim() : String(item?.url || item?.path || "").trim();
  const index = attachments.findIndex((item) => getAttachmentKey(item) === targetKey);
  if (index < 0) return json({ ok: false, error: "La foto ya no está adjunta a esta OPA. Actualiza la búsqueda e intenta de nuevo." }, 409);

  const removed = attachments[index];
  const remaining = attachments.filter((_, attachmentIndex) => attachmentIndex !== index);
  const storedValue = fileType === "text"
    ? JSON.stringify({ version: 1, link: existingGuide.link, photos: remaining })
    : remaining;
  await updateDashboardRow(env, tableName, rowId, { [columnName]: storedValue });

  const removedName = typeof removed === "string"
    ? removed.split("/").pop()
    : String(removed?.name || getAttachmentKey(removed).split("/").pop() || "foto");
  const auditTask = recordBusinessAudit(env, {
    username: user.username,
    role: user.rol,
    action: "ELIMINAR_FOTO_OPA",
    detail: { columna: columnName, archivo: removedName },
    opa: String(form.get("numeroOPA") || ""),
    table: tableName,
    row: rowId,
  });
  if (typeof context?.waitUntil === "function") context.waitUntil(auditTask);
  else await auditTask;

  const images = await Promise.all(remaining.map(async (item) => {
    const path = getAttachmentKey(item);
    const name = typeof item === "string" ? path.split("/").pop() : String(item?.name || path.split("/").pop());
    if (/^https?:\/\//i.test(path)) return { name, url: path, attachmentKey: path };
    try { return { name, url: await getDashboardFileDownloadLink(env, pathToImagePath(path)), attachmentKey: path }; }
    catch (_) { return { name, url: "", attachmentKey: path }; }
  }));
  return json({
    ok: true,
    columna: columnKey,
    imagenes: images,
    cantidad: 1,
    valorGuardado: storedValue,
    enlaceGuia: existingGuide?.link || "",
    mensaje: "La foto se eliminó de la OPA.",
  });
}

function normalizeExisting(value, type) {
  if (Array.isArray(value)) return value.filter((item) => type === "image" ? typeof item === "string" : item && typeof item === "object");
  if (typeof value === "string" && value.trim()) {
    if (type === "image") return [value.trim()];
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; }
  }
  return [];
}

function normalizeTextGuide(value) {
  const text = String(value || "").trim();
  if (!text) return { link: "", photos: [] };
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { link: "", photos: parsed.map((item) => typeof item === "string" ? item : item?.url || "").filter(Boolean) };
    if (parsed && typeof parsed === "object") return {
      link: String(parsed.link || parsed.enlace || ""),
      photos: Array.isArray(parsed.photos || parsed.fotos || parsed.attachments) ? (parsed.photos || parsed.fotos || parsed.attachments).map((item) => typeof item === "string" ? item : item?.url || "").filter(Boolean) : [],
    };
  } catch (_) {}
  if (/^https?:\/\//i.test(text)) return { link: text, photos: [] };
  return { link: "", photos: text.split(/[\r\n]+/).map((item) => item.trim()).filter((item) => /^\/(?:workspace\/\d+\/)?(?:images|files)\//i.test(item)) };
}

function pathToImagePath(value) {
  const match = String(value || "").match(/\/(images|files)\/([0-9]{4}-[0-9]{2})\/([^/?#]+)/i);
  if (!match) throw new Error("No se pudo reconocer la ruta de una imagen guardada.");
  return `/${match[1].toLowerCase()}/${match[2]}/${match[3]}`;
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
