/* ============================================================
   DASHBOARD COL-FT-001
   CODE.GS — VERSION OPTIMIZADA 2026
   ------------------------------------------------------------
   OPTIMIZACIONES CLAVE:
   1. Cache ultra-corto (10s) + onEdit invalida → cambios en vivo
   2. ETag / checksum rápido → cliente evita re-render si no cambió
   3. Lectura de TODAS las columnas del Excel (no solo 5 campos)
   4. Funciones de agregado pre-calculadas para análisis diario
   5. Lectura single-pass por hoja + índices de encabezado reutilizables
============================================================ */


/* ============================================================
   CONFIGURACION
============================================================ */

const CACHE_KEY         = 'DASHBOARD_COL_FT_OPT_V5_DATOS';
const CACHE_KEY_ANALISIS= 'DASHBOARD_COL_FT_OPT_V5_ANALISIS';
const CACHE_TIME        = 12;   // antes 8s → 12s (menos recargas full; sigue más fresco que polling 2s * 6)
const CACHE_LONG_SEC    = 300;  // antes 120s → 5min (menos lecturas Properties frías)
const CACHE_KEY_COLS    = 'DASHBOARD_COL_FT_OPT_V5_COLS';
const CACHE_KEY_ETAG    = 'DASHBOARD_COL_FT_OPT_V5_ETAG';


/* ============================================================
   MAPEO DE COLUMNAS (construido 1 vez en scope global)
   — alias normalizados sin acentos para matching robusto
============================================================ */
const MAPEO_CAMPOS_GLOBAL = [
  { nombre: 'PROYECTO',                     clave: 'P',   tipo: 'txt' },
  { nombre: 'TIPO DE PRODUCTO',             clave: 'T',   tipo: 'txt' },
  { nombre: 'TIPO DE PRODUCTO ESPECIFICO',  clave: 'TE',  tipo: 'txt' },
  { nombre: 'TIPO DE PRODUCTO ESPECÍFICO',  clave: 'TE',  tipo: 'txt' },
  { nombre: 'MARCA',                        clave: 'M',   tipo: 'txt' },
  { nombre: 'TERRITORIO',                   clave: 'TR',  tipo: 'txt' },
  { nombre: 'LINK O FOTO PRODUCTO',         clave: 'LF',  tipo: 'txt' },
  { nombre: 'LINK O FOTO',                  clave: 'LF',  tipo: 'txt' },
  { nombre: 'PORTAFOLIO',                   clave: 'PO',  tipo: 'txt' },
  { nombre: 'ITEM / SKU B2B',               clave: 'B2B', tipo: 'txt' },
  { nombre: 'ITEM/SKU B2B',                 clave: 'B2B', tipo: 'txt' },
  { nombre: 'SKU B2B',                      clave: 'B2B', tipo: 'txt' },
  { nombre: 'ITEM / SKU B2C',               clave: 'B2C', tipo: 'txt' },
  { nombre: 'ITEM/SKU B2C',                 clave: 'B2C', tipo: 'txt' },
  { nombre: 'SKU B2C',                      clave: 'B2C', tipo: 'txt' },
  { nombre: 'DESCRIPCIÓN DEL PRODUCTO ERP', clave: 'D',   tipo: 'txt' },
  { nombre: 'DESCRIPCION DEL PRODUCTO ERP', clave: 'D',   tipo: 'txt' },
  { nombre: 'NOMBRE DE PRODUCTO EN OPA',    clave: 'NP',  tipo: 'txt' },
  { nombre: 'NUMERO DE OPA',                clave: 'O',   tipo: 'txt' },
  { nombre: 'NÚMERO DE OPA',                clave: 'O',   tipo: 'txt' },
  { nombre: 'SUBOPA',                       clave: 'SO',  tipo: 'txt' },
  { nombre: 'SUB-OPA',                      clave: 'SO',  tipo: 'txt' },
  { nombre: 'PERSONAJE',                    clave: 'PJ',  tipo: 'txt' },
  { nombre: 'ESTADO PLATAFORMA',            clave: 'E',   tipo: 'txt' },
  { nombre: 'FECHA',                        clave: 'F',   tipo: 'fecha' },
  { nombre: 'CONCEPTO ENVIADO',             clave: 'F1',  tipo: 'fecha' },
  { nombre: 'CONCEPTO APROBADO',            clave: 'F2',  tipo: 'fecha' },
  { nombre: 'PRE-PRODUCCION ENVIADA',       clave: 'F3',  tipo: 'fecha' },
  { nombre: 'PRE-PRODUCCIÓN ENVIADA',       clave: 'F3',  tipo: 'fecha' },
  { nombre: 'PRE-PRODUCCION APROBADA',      clave: 'F4',  tipo: 'fecha' },
  { nombre: 'PRE-PRODUCCIÓN APROBADA',      clave: 'F4',  tipo: 'fecha' },
  { nombre: 'FOTOS DE PRODUCION ENVIADA',   clave: 'F5',  tipo: 'fecha' },
  { nombre: 'FOTOS DE PRODUCCION ENVIADA',  clave: 'F5',  tipo: 'fecha' },
  { nombre: 'FOTOS DE PRODUCCIÓN ENVIADA',  clave: 'F5',  tipo: 'fecha' },
  { nombre: 'FOTOS DE PRODUCION APROBADA',  clave: 'F6',  tipo: 'fecha' },
  { nombre: 'FOTOS DE PRODUCCION APROBADA', clave: 'F6',  tipo: 'fecha' },
  { nombre: 'FOTOS DE PRODUCCIÓN APROBADA', clave: 'F6',  tipo: 'fecha' },
  { nombre: 'MUESTRAS FINALES ENVIADAS',    clave: 'F7',  tipo: 'fecha' },
  { nombre: 'MUESTRAS FINALES ENVIADO',     clave: 'F7',  tipo: 'fecha' },
  { nombre: 'APROBADA / CERRADA',           clave: 'F8',  tipo: 'fecha' },
  { nombre: 'FECHA ENVIO DE MUESTRAS',      clave: 'FM',  tipo: 'fecha' },
  { nombre: 'FECHA DE ENVIO DE MUESTRAS',   clave: 'FM',  tipo: 'fecha' },
  { nombre: 'FECHA ENVÍO DE MUESTRAS',      clave: 'FM',  tipo: 'fecha' },
  { nombre: 'CANTIDAD MUESTRAS RECIBIDAS',  clave: 'MR',  tipo: 'num' },
  { nombre: 'CANTIDAD DE MUESTRAS RECIBIDAS',clave: 'MR', tipo: 'num' },
  { nombre: 'MUESTRAS RECIBIDAS',           clave: 'MR',  tipo: 'num' },
  { nombre: 'CANTIDAD DE MUESTRAS ENVIADAS',clave: 'ME',  tipo: 'num' },
  { nombre: 'CANTIDAD MUESTRAS ENVIADAS',   clave: 'ME',  tipo: 'num' },
  { nombre: 'MUESTRAS ENVIADAS',            clave: 'ME',  tipo: 'num' },
  { nombre: 'ENLACE GUÍA DE ENVÍO',         clave: 'GE',  tipo: 'txt' },
  { nombre: 'ENLACE GUIA DE ENVIO',         clave: 'GE',  tipo: 'txt' },
  { nombre: 'GUIA DE ENVIO',                clave: 'GE',  tipo: 'txt' }
];
const MAPEO_ALIAS_GLOBAL = _buildAliasBusqueda(MAPEO_CAMPOS_GLOBAL);
const MAPEO_CAMPOS_CLAVES = (function(){
  var o = {};
  for (var i=0;i<MAPEO_CAMPOS_GLOBAL.length;i++) o[MAPEO_CAMPOS_GLOBAL[i].clave]=true;
  return Object.keys(o);
})();
const COLORES_ESTADOS_GLOBAL = [
  '#2563eb','#3b82f6','#f59e0b','#d97706',
  '#8b5cf6','#7c3aed','#16a34a','#15803d',
  '#dc2626','#64748b','#0891b2','#059669','#0ea5e9','#ef4444'
];


/* ============================================================
   ESTADOS OFICIALES DEL FLUJO (orden 8 pasos + cancelado)
============================================================ */

const ESTADOS_DASHBOARD = [
  'Concepto Enviado',
  'Concepto Aprobado',
  'Pre-Producción Enviada',
  'Pre-Producción Aprobada',
  'Fotos de Producción Enviada',
  'Fotos de Producción Aprobada',
  'Muestras Finales Enviadas',
  'Aprobada / Cerrada',
  'Cancelado'
];

const ESTADOS_DASHBOARD_NORM = ESTADOS_DASHBOARD.map(function(e){
  return normalizarEncabezado(e);
});


/* ============================================================
   ABRIR COMO APLICACION WEB
============================================================ */

function doGet() {
  var template = null;
  var nombres = ['Index', 'index', 'index.html', 'Index.html'];
  for (var i = 0; i < nombres.length; i++) {
    try {
      template = HtmlService.createHtmlOutputFromFile(nombres[i]);
      break;
    } catch (_) { template = null; }
  }
  if (!template) {
    return HtmlService.createHtmlOutput(
      '<h2 style="color:#b91c1c;">❌ Error: No se encontró el archivo HTML</h2>' +
      '<p>En el editor de Apps Script crea o renombra el archivo HTML como: <b>Index</b> o <b>index</b>.</p>'
    ).setTitle('Error Dashboard');
  }
  return template
    .setTitle('Dashboard COL-FT-001')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/* ============================================================
   MENU GOOGLE SHEETS
============================================================ */

function onOpen() {
  SpreadsheetApp
    .getUi()
    .createMenu('📊 Dashboard')
    .addItem('Abrir Dashboard',        'mostrarDashboard')
    .addItem('🔄 Limpiar caché',        'limpiarCacheDashboard')
    .addItem('📈 Ver análisis rápido',  'mostrarDashboard')
    .addToUi();
}


/* ============================================================
   ABRIR DENTRO DE GOOGLE SHEETS
============================================================ */

function mostrarDashboard() {
  const html = HtmlService
    .createHtmlOutputFromFile('Index')
    .setWidth(1480)
    .setHeight(920);
  SpreadsheetApp.getUi().showModalDialog(html, 'Dashboard COL-FT-001');
}


/* ============================================================
   ✨ NUEVO: CHECKSUM RAPIDO (para polling cada 2s)
   Devuelve: { etag, fechaActualizacion, totalFilas }
   No lee datos, es O(1) y dura ~2ms.
============================================================ */

/* ============================================================
   ETag REAL de la hoja: NO usa tiempo.
   Si no hay ediciones, el etag es ESTABLE → cliente evita full-sync.
   = (id_ss | [hoja nombre : filas x cols : A1_hash : última fila hash ])
============================================================ */
function _calcularEtagHoja() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojas = ss.getSheets();
  let filasTotal = 0;
  let cadenaHash = ss.getId() + '|' + hojas.length + '|';
  for (let i = 0; i < hojas.length; i++) {
    const h = hojas[i];
    const lr = h.getLastRow();
    const lc = h.getLastColumn();
    filasTotal += Math.max(0, lr - 1);
    let chunk = '';
    try {
      if (lr > 0 && lc > 0) {
        const a1 = h.getRange(1, 1, 1, Math.min(lc, 20)).getDisplayValues()[0] || [];
        chunk = a1.join('|');
        if (lr > 1) {
          const last = h.getRange(lr, 1, 1, Math.min(lc, 20)).getDisplayValues()[0] || [];
          chunk += '||' + last.join('|');
        }
      }
    } catch(_) {}
    cadenaHash += '[' + h.getName() + ':' + lr + 'x' + lc + ':' + _hashSimple(chunk) + ']';
  }
  return {
    etag: _hashSimple(cadenaHash),
    totalFilas: filasTotal
  };
}

function obtenerChecksumDashboard() {
  try {
    const cache = CacheService.getScriptCache();
    let cached = null;
    try { cached = cache.get(CACHE_KEY_ETAG + '_OBJ'); } catch(_) {}
    let etagInfo;
    if (cached) {
      try { etagInfo = JSON.parse(cached); } catch(_){}
    }
    if (!etagInfo) {
      etagInfo = _calcularEtagHoja();
      try { cache.put(CACHE_KEY_ETAG + '_OBJ', JSON.stringify(etagInfo), Math.max(2, CACHE_TIME - 1)); } catch(_) {}
    }
    return {
      ok: true,
      etag: etagInfo.etag,
      totalFilas: etagInfo.totalFilas || 0,
      fechaActualizacion: Utilities.formatDate(
        new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'
      )
    };
  } catch (err) {
    return {
      ok: false,
      etag: 'err-' + Date.now(),
      totalFilas: 0,
      fechaActualizacion: '',
      error: err.message
    };
  }
}


/* ============================================================
   OBTENER DATOS + ANÁLISIS DASHBOARD (1 SOLA LECTURA)
   Devuelve: { registros:[], columnas:[], etag, resumenRapido, analisis:{...} }
   — analisis ya viene calculado → evita 2da llamada costosa al servidor
============================================================ */
function _normFechaGlobal(raw){
  if (!raw) return '';
  let txt = limpiarTexto(String(raw));
  if (!txt) return '';

  // ============================================================
  // 1) FORMATO MES EN TEXTO ESPAÑOL (CASO QUE FALTABA):
  //    "21/septiembre/26"  |  "21 de septiembre de 2026"
  //    "21-sep-26"         |  "21 sep 2026"
  // ============================================================
  const MESES_ES = {
    ene: 1, enero: 1,
    feb: 2, febrero: 2,
    mar: 3, marzo: 3,
    abr: 4, abril: 4,
    may: 5, mayo: 5,
    jun: 6, junio: 6,
    jul: 7, julio: 7,
    ago: 8, agosto: 8,
    sep: 9, sept: 9, septiembre: 9,
    oct:10, octubre:10,
    nov:11, noviembre:11,
    dic:12, diciembre:12,
    'setiembre': 9,
    'set': 9
  };
  const m = txt.toLowerCase().match(/(\d{1,2})[\s\/\-\.]+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|sept)[a-z]*[\s\/\-\.]+(\d{2,4})/);
  if (m) {
    let d  = parseInt(m[1],10);
    let me = (MESES_ES[m[2]] || 0);
    let a  = parseInt(m[3],10);
    if (a && a < 100) a += 2000;
    if (d>=1 && d<=31 && me>=1 && me<=12 && a>=2000 && a<=2100) {
      return a + '-' + (me<10?'0':'') + me + '-' + (d<10?'0':'') + d;
    }
  }

  // 2) Formato numérico DD/MM/AAAA o DD-MM-AA
  let mn = txt.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (mn) {
    let d = +mn[1], mm = +mn[2], a = +mn[3];
    if (a && a < 100) a += 2000;
    if (d<1||d>31||mm<1||mm>12) return '';
    return a + '-' + (mm<10?'0':'') + mm + '-' + (d<10?'0':'') + d;
  }
  // 3) Formato ISO  AAAA/MM/DD
  mn = txt.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (mn) {
    let a = +mn[1], mm = +mn[2], d = +mn[3];
    if (a < 100) a += 2000;
    if (d<1||d>31||mm<1||mm>12) return '';
    return a + '-' + (mm<10?'0':'') + mm + '-' + (d<10?'0':'') + d;
  }
  // 4) Fecha nativa JS
  try {
    const d = new Date(txt);
    if (!isNaN(d.getTime())) {
      const a = d.getFullYear();
      const mm = d.getMonth()+1;
      const dia = d.getDate();
      return a + '-' + (mm<10?'0':'') + mm + '-' + (dia<10?'0':'') + dia;
    }
  } catch(_) {}
  return '';
}

function _numGlobal(v){
  if (v === null || v === undefined) return 0;
  const s = limpiarTexto(String(v)).replace(/,/g,'.');
  if (!s) return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function _construirAnalisisDesdeRegistros(registros, resumen) {
  if (!registros) registros = [];
  if (!resumen) resumen = _calcularResumenRapido(registros);
  const totalGeneral = registros.length;

  var porEstadoMap = {};
  var porDiaMap = {};
  var porProyectoMap = {};

  for (var i = 0; i < registros.length; i++) {
    var r = registros[i];
    if (!r) continue;

    // 1) Estado
    var estado = limpiarTexto(r.E) || 'Sin estado';
    if (!porEstadoMap[estado]) porEstadoMap[estado] = 0;
    porEstadoMap[estado]++;

    // 2) Proyecto
    var p = limpiarTexto(r.P) || 'Sin proyecto';
    if (!porProyectoMap[p]) porProyectoMap[p] = { total: 0, completados: 0 };
    porProyectoMap[p].total++;
    var ne = normalizarEncabezado(estado);
    if (ne.indexOf('APROBADO') !== -1 || ne.indexOf('CERRADO') !== -1 || ne.indexOf('FINAL') !== -1) {
      porProyectoMap[p].completados++;
    }

    // 3) Fecha: la MÁS ACTUAL entre todas las etapas (F8..F1, F, FM) = última fecha del proceso.
    //    Antes: tomaba la PRIMERA no vacía → fechas antiguas y fallaba conteo por día.
    var fechaMax = '';
    var fechasEvaluadas = [
      r.F,
      r.F8, r.F7, r.F6, r.F5, r.F4, r.F3, r.F2, r.F1,
      r.FM, r.MR, r.ME
    ];
    for (var idxF = 0; idxF < fechasEvaluadas.length; idxF++) {
      var ftmp = fechasEvaluadas[idxF];
      if (!ftmp) continue;
      if (fechaMax === '' || ftmp > fechaMax) fechaMax = ftmp;
    }
    var fecha = fechaMax;
    if (!fecha) continue;
    if (!porDiaMap[fecha]) porDiaMap[fecha] = { fecha: fecha, total: 0, estados: {} };
    var d = porDiaMap[fecha];
    d.total++;
    d.estados[estado] = (d.estados[estado] || 0) + 1;
  }

  // ---- Lista porEstado ----
  var porEstadoLista = [];
  var idxColor = 0;
  var keys = Object.keys(porEstadoMap);
  for (var k = 0; k < keys.length; k++) {
    var est = keys[k];
    var val = porEstadoMap[est];
    porEstadoLista.push({
      estado: est,
      valor:  val,
      color:  COLORES_ESTADOS_GLOBAL[idxColor++ % COLORES_ESTADOS_GLOBAL.length],
      porcentaje: totalGeneral > 0 ? Math.round((val / totalGeneral) * 1000) / 10 : 0
    });
  }
  porEstadoLista.sort(function(a,b){ return b.valor - a.valor; });

  // ---- Lista porDia ----
  var porDiaLista = [];
  var keys2 = Object.keys(porDiaMap);
  for (var k2 = 0; k2 < keys2.length; k2++) {
    porDiaLista.push(porDiaMap[keys2[k2]]);
  }
  porDiaLista.sort(function(a,b){ return a.fecha < b.fecha ? -1 : (a.fecha > b.fecha ? 1 : 0); });
  var ultimos14Dias = porDiaLista.slice(-14);

  // ---- Lista porProyecto ----
  var porProyectoLista = [];
  var keys3 = Object.keys(porProyectoMap);
  for (var k3 = 0; k3 < keys3.length; k3++) {
    var obj = porProyectoMap[keys3[k3]];
    porProyectoLista.push({
      proyecto: keys3[k3],
      total: obj.total,
      completados: obj.completados,
      avance: obj.total > 0 ? Math.round((obj.completados / obj.total) * 1000) / 10 : 0
    });
  }
  porProyectoLista.sort(function(a,b){ return b.total - a.total; });

  return {
    ok: true,
    totalGeneral: totalGeneral,
    resumenRapido: resumen,
    porEstado: porEstadoLista,
    porDia: porDiaLista,
    ultimos14Dias: ultimos14Dias,
    porProyecto: porProyectoLista.slice(0, 20)
  };
}

function obtenerDatosDashboard() {
  var cache = CacheService.getScriptCache();
  var props = PropertiesService.getScriptProperties();
  var cacheKey       = CACHE_KEY;
  var cacheAnalisis  = CACHE_KEY_ANALISIS;
  var cachedAtKey    = CACHE_KEY + '_TIME';
  var etagKey        = CACHE_KEY_ETAG;

  // 1) Caché corta (8s)
  try {
    var cacheShort = cache.get(cacheKey);
    if (cacheShort) {
      try {
        var parsed = JSON.parse(cacheShort);
        if (parsed && parsed.registros) return parsed;
      } catch (_) { try { cache.remove(cacheKey); } catch(e){} }
    }
  } catch(_) {}

  // 2) Caché larga (2 min)
  try {
    var longCached = props.getProperty(cacheKey);
    var cachedAt   = props.getProperty(cachedAtKey);
    if (longCached && cachedAt) {
      var edad = (Date.now() - Number(cachedAt)) / 1000;
      if (edad < CACHE_LONG_SEC) {
        try {
          var parsed2 = JSON.parse(longCached);
          if (parsed2 && parsed2.registros) {
            try { cache.put(cacheKey, JSON.stringify(parsed2), CACHE_TIME); } catch(_){}
            return parsed2;
          }
        } catch (_) { try { props.deleteProperty(cacheKey); } catch(e){} }
      }
    }
  } catch(_) {}

  // 3) ETag real
  var etagInfo;
  try { etagInfo = _calcularEtagHoja(); } catch(_) { etagInfo = { etag: 'err-static-1', totalFilas: 0 }; }

  // 4) Lectura REAL desde Sheets (bulk single-pass)
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No se pudo acceder al archivo de Google Sheets.');
  var hojas = ss.getSheets();
  var registros = [];
  var _textoVacioOPA = {'':1,'N/A':1,'NA':1,'N.A.':1,'-':1,'SIN OPA':1,'NINGUNO':1,'NINGUNA':1};
  var columnasFinales = MAPEO_CAMPOS_CLAVES;

  for (var hi = 0; hi < hojas.length; hi++) {
    var hoja = hojas[hi];
    try {
      var ultimaFila    = hoja.getLastRow();
      var ultimaColumna = hoja.getLastColumn();
      if (ultimaFila < 2 || ultimaColumna < 1) continue;

      // Leer primero solo encabezados. Algunas hojas tienen columnas vacías o
      // auxiliares al final; no hace falta transferirlas para cada fila.
      var encabezados = hoja.getRange(1, 1, 1, ultimaColumna).getDisplayValues()[0];
      if (!encabezados || !encabezados.length) continue;

      // Índice columna→clave (usando alias global 1 sola vez construido)
      var idxPorClave = {};
      var encAbsNormalizados = [];
      // PRIMER PASO: matching EXACTO (normalización ya quita símbolos/espacios → MARCA:)
      for (var ci = 0; ci < encabezados.length; ci++) {
        var enc = normalizarEncabezado(encabezados[ci]);
        encAbsNormalizados.push(enc);
        if (!enc) continue;
        var clave = MAPEO_ALIAS_GLOBAL[enc];
        if (clave && !(clave in idxPorClave)) idxPorClave[clave] = ci;
      }
      // SEGUNDO PASO: matching FUZZY bidireccional por contains
      //   → si una pestaña usa "MARCA:" o "NOMBRE DE MARCA CLIENTE" → coincide con alias MARCA
      //   → solo para claves NO encontradas en paso 1 y columnas SIN asignar; prioriza alias más largo
      try {
        var aliasList = [];
        for (var alKey in MAPEO_ALIAS_GLOBAL) {
          aliasList.push([alKey, MAPEO_ALIAS_GLOBAL[alKey]]);
        }
        aliasList.sort(function(a,b){ return b[0].length - a[0].length; });
        for (var ak = 0; ak < aliasList.length; ak++) {
          var aliasNom = aliasList[ak][0];
          var aliasClv = aliasList[ak][1];
          if (!aliasNom || aliasNom.length < 3) continue;
          if (aliasClv in idxPorClave) continue; // ya encontrado en paso exacto
          for (var ci2 = 0; ci2 < encAbsNormalizados.length; ci2++) {
            var encN = encAbsNormalizados[ci2];
            if (!encN || encN.length < 3) continue;
            // flag: no reasignar columna que ya tiene clave
            var yaUsada = false;
            for (var _kk in idxPorClave) {
              if (idxPorClave[_kk] === ci2) { yaUsada = true; break; }
            }
            if (yaUsada) continue;
            if (encN === aliasNom) continue; // exacto se manejó arriba
            var match = (encN.indexOf(aliasNom) !== -1) || (aliasNom.indexOf(encN) !== -1);
            if (match) { idxPorClave[aliasClv] = ci2; break; }
          }
        }
      } catch(_fuzzyErr) { Logger.log('Fuzzy matching warn: ' + _fuzzyErr.message); }
      if (Object.keys(idxPorClave).length === 0) continue;
      var columnasNecesarias = 0;
      for (var claveNecesaria in idxPorClave) {
        columnasNecesarias = Math.max(columnasNecesarias, idxPorClave[claveNecesaria] + 1);
      }
      if (!columnasNecesarias) continue;
      var datos = hoja.getRange(2, 1, ultimaFila - 1, columnasNecesarias).getDisplayValues();
      if (!datos || !datos.length) continue;
      var nombreHoja = limpiarTexto(hoja.getName());

      // Construir array de lookups por clave (reduce ifs en loop interno)
      var lookupClave = {};
      var lookupTipo = {};
      for (var mm = 0; mm < MAPEO_CAMPOS_GLOBAL.length; mm++) {
        var mmm = MAPEO_CAMPOS_GLOBAL[mm];
        if (!(mmm.clave in lookupClave)) {
          lookupClave[mmm.clave] = idxPorClave[mmm.clave];
          lookupTipo [mmm.clave] = mmm.tipo;
        }
      }

      for (var i = 0; i < datos.length; i++) {
        var fila = datos[i];
        if (!fila) continue;
        var reg = { H: nombreHoja };
        var tieneDatos = false;
        var yaTiene = {};

        // Loop sobre claves únicas (34 cols) no sobre MAPEO_CAMPOS entero
        for (var cc = 0; cc < columnasFinales.length; cc++) {
          var clv = columnasFinales[cc];
          var idxx = lookupClave[clv];
          if (idxx === undefined) { reg[clv] = (clv==='MR'||clv==='ME'?0:''); continue; }
          var rawv = fila[idxx];
          var valr;
          var tp = lookupTipo[clv];
          if (tp === 'fecha') valr = _normFechaGlobal(rawv);
          else if (tp === 'num') valr = _numGlobal(rawv);
          else valr = limpiarTexto(rawv);
          reg[clv] = valr;
          if (valr !== '' && valr !== 0) tieneDatos = true;
        }

        if (reg.O !== undefined && _textoVacioOPA[String(reg.O||'').toUpperCase()] === 1) {
          reg.O = '';
        }

        if (!tieneDatos) {
          if ((reg.P||'')==='' && (reg.T||'')==='' && (reg.E||'')==='' && (reg.O||'')==='') continue;
        }

        registros.push(reg);
      }
    } catch (err) {
      Logger.log('Hoja "' + hoja.getName() + '" error: ' + err.message);
    }
  }

  var resumenRapido = _calcularResumenRapido(registros);
  var analisis = _construirAnalisisDesdeRegistros(registros, resumenRapido);

  var ahora = new Date();
  var tz = Session.getScriptTimeZone();
  var respuesta = {
    registros: registros,
    columnas:  columnasFinales,
    etag:      etagInfo.etag,
    totalRegistros: registros.length,
    resumenRapido:  resumenRapido,
    analisis:  analisis,
    fechaActualizacion: Utilities.formatDate(ahora, tz, 'dd/MM/yyyy HH:mm:ss')
  };

  var serializada;
  try {
    serializada = JSON.stringify(respuesta);
  } catch(e) {
    respuesta.analisis = null;
    serializada = JSON.stringify(respuesta);
  }

  try { cache.put(cacheKey, serializada, CACHE_TIME); } catch(_){}
  try {
    props.setProperty(cacheKey, serializada);
    props.setProperty(cachedAtKey, String(Date.now()));
    props.setProperty(etagKey, etagInfo.etag);
  } catch(_){}

  return respuesta;
}


/* ============================================================
   ✨ OBTENER ANÁLISIS (ahora es CHAPA: reutiliza obtenerDatosDashboard)
============================================================ */
function obtenerAnalisisDashboard() {
  try {
    var data = obtenerDatosDashboard();
    var an = (data && data.analisis) ? data.analisis :
             _construirAnalisisDesdeRegistros((data && data.registros) || [], data && data.resumenRapido);
    return {
      ok: true,
      etag: (data && data.etag) || ('a-' + Date.now()),
      fechaActualizacion: (data && data.fechaActualizacion) || '',
      totalGeneral: an.totalGeneral || 0,
      resumenRapido: an.resumenRapido,
      porEstado: an.porEstado || [],
      porDia: an.porDia || [],
      ultimos14Dias: an.ultimos14Dias || [],
      porProyecto: an.porProyecto || []
    };
  } catch(err) {
    return {
      ok: false,
      error: err.message,
      etag: 'err-' + Date.now(),
      totalGeneral: 0,
      porEstado: [], porDia: [], ultimos14Dias: [], porProyecto: []
    };
  }
}


/* ============================================================
   FUNCIONES AUXILIARES
============================================================ */

function _buildAliasBusqueda(MAPEO_CAMPOS) {
  const map = {};
  for (let i = 0; i < MAPEO_CAMPOS.length; i++) {
    const m = MAPEO_CAMPOS[i];
    const encNorm = normalizarEncabezado(m.nombre);
    if (!map[encNorm]) map[encNorm] = m.clave;
    // Para FECHA*: matching flexible
    if (m.clave === 'F') {
      if (!map['FECHA']) map['FECHA'] = 'F';
    }
  }
  // Búsqueda flexible extra
  const extras = {
    'FECHA ENVIO': 'FM',
    'FECHA DE ENVIO': 'FM',
    'FECHA ENVÍO': 'FM',
    'FECHA DE ENVÍO': 'FM',
    'MUESTRAS RECIBIDAS CANTIDAD': 'MR'
  };
  for (const k in extras) {
    if (!map[normalizarEncabezado(k)]) map[normalizarEncabezado(k)] = extras[k];
  }
  return map;
}

function _hashSimple(str) {
  // djb2 xor hash (suficiente para ETag no criptográfico)
  let hash = 5381;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
  }
  return 'h' + Math.abs(hash).toString(36);
}

function _calcularResumenRapido(registros) {
  const opasUnicas = new Set();
  const proyectos  = new Set();
  const marcas     = new Set();
  const territorios = new Set();
  const estadosCount = {};
  let muestrasRecibidas = 0;
  let muestrasEnviadas  = 0;
  let conFecha = 0;

  for (let i = 0; i < registros.length; i++) {
    const r = registros[i];
    if (!r) continue;
    if (r.O) opasUnicas.add(String(r.O));
    if (r.P) proyectos.add(String(r.P));
    if (r.M) marcas.add(String(r.M));
    if (r.TR) territorios.add(String(r.TR));
    if (r.F) conFecha++;
    if (r.MR) muestrasRecibidas += Number(r.MR) || 0;
    if (r.ME) muestrasEnviadas  += Number(r.ME) || 0;
    const e = limpiarTexto(r.E) || 'Sin estado';
    estadosCount[e] = (estadosCount[e] || 0) + 1;
  }

  return {
    totalRegistros: registros.length,
    opasUnicas:     opasUnicas.size,
    proyectos:      proyectos.size,
    marcas:         marcas.size,
    territorios:    territorios.size,
    conFecha:       conFecha,
    muestrasRecibidas: Math.round(muestrasRecibidas * 100) / 100,
    muestrasEnviadas:  Math.round(muestrasEnviadas * 100) / 100,
    estadosCount:   estadosCount
  };
}

function normalizarEncabezado(valor) {
  // Normalización ROBUSTA v5:
  //   - Mayúsculas, sin acentos, SIN espacios, SIN símbolos (. : - _ ( ) [ ] / * = ? ! , ;)
  //   - "MARCA:" → "MARCA", "  N O M B R E   E N   O P A  " → "NOMBREENOPA"
  //   - "TERRITORIO (TR)" → "TERRITORIOTR" coincide con alias TERRITORIO/TR
  var base = limpiarTexto(valor)
    .toUpperCase()
    .replace(/[ÁÀÄÂ]/g, 'A')
    .replace(/[ÉÈËÊ]/g, 'E')
    .replace(/[ÍÌÏÎ]/g, 'I')
    .replace(/[ÓÒÖÔ]/g, 'O')
    .replace(/[ÚÙÜÛ]/g, 'U')
    .replace(/[^\wÑ]/g, '')
    .replace(/_/g, '');
  return base;
}

function limpiarTexto(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .replace(/\u00A0/g, ' ')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buscarEncabezado(encabezados, campo) {
  const campoNormalizado = normalizarEncabezado(campo);
  let idx = encabezados.indexOf(campoNormalizado);
  if (idx !== -1) return idx;
  idx = encabezados.findIndex(function(e){
    if (!e) return false;
    if (campoNormalizado === 'FECHA') {
      return e === 'FECHA' || e.indexOf('FECHA DE') === 0 || e.indexOf('FECHA PROCESO') === 0 || e.indexOf('DIA') === 0;
    }
    return e.indexOf(campoNormalizado) !== -1 || campoNormalizado.indexOf(e) !== -1;
  });
  return idx;
}

function esValorVacioOPA(valor) {
  const t = limpiarTexto(valor).toUpperCase();
  return t === '' || t === 'N/A' || t === 'NA' || t === 'N.A.' || t === '-' || t === 'SIN OPA';
}


/* ============================================================
   LIMPIAR CACHE
============================================================ */

function _limpiarCacheCorta() {
  try {
    const c = CacheService.getScriptCache();
    c.remove(CACHE_KEY);
    c.remove(CACHE_KEY_COLS);
    c.remove(CACHE_KEY_ETAG);
    c.remove(CACHE_KEY_ETAG + '_OBJ');
  } catch(_){}
}

function limpiarCacheDashboard() {
  _limpiarCacheCorta();
  try {
    const p = PropertiesService.getScriptProperties();
    p.deleteProperty(CACHE_KEY);
    p.deleteProperty(CACHE_KEY + '_TIME');
    p.deleteProperty(CACHE_KEY_COLS);
    p.deleteProperty(CACHE_KEY_ETAG);
  } catch(_){}
}


/* ============================================================
   INVALIDAR CACHE CUANDO SE EDITA LA HOJA
   — onEdit es "simple trigger" → sin acceso a PropertiesService,
     solo limpiamos caché corta (10s) → máximo 10s de stale.
============================================================ */

function onEdit(e) {
  try { _limpiarCacheCorta(); } catch(_){}
}

function onInstall(e) {
  onOpen(e);
}


/* ============================================================
   REFRESCO MANUAL
============================================================ */

function actualizarDashboardDatos() {
  limpiarCacheDashboard();
  return obtenerDatosDashboard();
}


/* ============================================================
   FUNCIONES AUXILIARES PÚBLICAS
============================================================ */

function obtenerEstadoCacheDashboard() {
  const props = PropertiesService.getScriptProperties();
  const cachedAt = props.getProperty(CACHE_KEY + '_TIME');
  if (!cachedAt) return { disponible: false, edadSegundos: null, fecha: null };
  const edad = (Date.now() - Number(cachedAt)) / 1000;
  return {
    disponible: edad < CACHE_LONG_SEC,
    edadSegundos: Math.round(edad),
    fecha: new Date(Number(cachedAt)).toISOString()
  };
}

function obtenerEstadosDashboard() {
  return ESTADOS_DASHBOARD.slice();
}


/* ============================================================
   🛡️ SISTEMA DE USUARIOS + AUTENTICACIÓN + AUDITORÍA
   -------------------------------------------------------
   - Hoja 1: "USUARIOS"         → id | username | nombre | rol | hashPwd | salt | fechaRegistro | ultimoAcceso | correo
   - Hoja 2: "HISTORIAL_AUDITORIA" → timestampISO | fechaHoraTxt | username | rol | tipoAccion | detalleJSON | opaAfectada | hojaAfectada | filaAfectada

   - Primer usuario en la hoja USUARIOS: rol = ADMINISTRADOR
   - Siguientes: rol = USUARIO por defecto
   - Contraseñas: hash SHA-256 con salt (nunca se guarda la original)
============================================================ */

const NOMBRE_HOJA_USUARIOS = 'USUARIOS';
const NOMBRE_HOJA_HISTORIAL = 'HISTORIAL_AUDITORIA';
const SCRIPT_PROP_SESIONES = 'DASHBOARD_SESIONES_V2';

function _sesionesMapLeer() {
  try {
    const sp = PropertiesService.getScriptProperties();
    const raw = sp.getProperty(SCRIPT_PROP_SESIONES);
    if (!raw) return {};
    const m = JSON.parse(raw);
    return (m && typeof m === 'object') ? m : {};
  } catch(_) { return {}; }
}

function _sesionesMapGuardar(map) {
  try {
    const sp = PropertiesService.getScriptProperties();
    sp.setProperty(SCRIPT_PROP_SESIONES, JSON.stringify(map || {}));
    return true;
  } catch(_) { return false; }
}

function _sesionesLimpiarExpiradas(map) {
  try {
    if (!map) return {};
    const limpio = {};
    const ahora = Date.now();
    for (let tk in map) {
      const s = map[tk];
      if (!s || !s.ts) continue;
      const life = Number(s.expiraMs) || (1000 * 60 * 60 * 12);
      const edad = ahora - new Date(s.ts).getTime();
      if (edad < life) limpio[tk] = s;
    }
    return limpio;
  } catch(_) { return map || {}; }
}

function _obtenerOHojarUsuarios() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let hoja = null;
    try { hoja = ss.getSheetByName(NOMBRE_HOJA_USUARIOS); } catch(_) {}
    const encabezadoNuevo = ['ID_USUARIO','USERNAME','NOMBRE_COMPLETO','ROL','HASH_PWD','SALT','FECHA_REGISTRO_ISO','ULTIMO_ACCESO_ISO','CORREO','PERMISOS_JSON'];
    if (!hoja) {
      hoja = ss.insertSheet(NOMBRE_HOJA_USUARIOS);
      hoja.appendRow(encabezadoNuevo);
      hoja.setFrozenRows(1);
      hoja.getRange(1,1,1,encabezadoNuevo.length).setBackground('#0f172a').setFontColor('#ffffff').setFontWeight('bold');
      try { hoja.setTabColor('#1e40af'); } catch(_) {}
    } else {
      const lr = hoja.getLastRow();
      const lc = Math.max(hoja.getLastColumn(), 1);
      if (lr === 0) {
        hoja.appendRow(encabezadoNuevo);
        hoja.setFrozenRows(1);
        hoja.getRange(1,1,1,encabezadoNuevo.length).setBackground('#0f172a').setFontColor('#ffffff').setFontWeight('bold');
      } else {
        // Migracion: añadir columna PERMISOS_JSON si no existe (columna 10)
        if (lc < 10) {
          hoja.getRange(1, 10).setValue('PERMISOS_JSON');
          const rg = hoja.getRange(1, 1, 1, Math.max(hoja.getLastColumn(), 10));
          rg.setBackground('#0f172a').setFontColor('#ffffff').setFontWeight('bold');
        } else {
          const actual = String(hoja.getRange(1, 10).getDisplayValue() || '').trim();
          if (actual.indexOf('PERMISOS') < 0) {
            hoja.insertColumnAfter(9);
            hoja.getRange(1, 10).setValue('PERMISOS_JSON');
            const rg = hoja.getRange(1, 1, 1, 10);
            rg.setBackground('#0f172a').setFontColor('#ffffff').setFontWeight('bold');
          }
        }
      }
    }
    return hoja;
  } catch(err) {
    return null;
  }
}

function _permisosPorDefecto(rol) {
  const esAdmin = String(rol || 'USUARIO') === 'ADMINISTRADOR';
  return {
    ver_dashboard: true,
    ver_analisis: true,
    ver_busqueda: true,
    cambiar_estado: esAdmin ? true : true,
    panel_admin: esAdmin
  };
}
function _parsePermisos(raw, rol) {
  try {
    const s = String(raw || '').trim();
    const base = _permisosPorDefecto(rol);
    if (!s) return base;
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object') {
      return {
        ver_dashboard: (typeof obj.ver_dashboard === 'boolean') ? obj.ver_dashboard : !!base.ver_dashboard,
        ver_analisis: (typeof obj.ver_analisis === 'boolean') ? obj.ver_analisis : !!base.ver_analisis,
        ver_busqueda: (typeof obj.ver_busqueda === 'boolean') ? obj.ver_busqueda : !!base.ver_busqueda,
        cambiar_estado: (typeof obj.cambiar_estado === 'boolean') ? obj.cambiar_estado : !!base.cambiar_estado,
        panel_admin: (typeof obj.panel_admin === 'boolean') ? obj.panel_admin : !!base.panel_admin
      };
    }
    return base;
  } catch(_) { return _permisosPorDefecto(rol); }
}

function _obtenerOHojarHistorial() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let hoja = null;
    try { hoja = ss.getSheetByName(NOMBRE_HOJA_HISTORIAL); } catch(_) {}
    if (!hoja) {
      hoja = ss.insertSheet(NOMBRE_HOJA_HISTORIAL);
      hoja.appendRow(['TIMESTAMP_ISO','FECHA_HORA_LOCAL','USERNAME','ROL','TIPO_ACCION','DETALLE_JSON','OPA_AFECTADA','HOJA_AFECTADA','FILA_AFECTADA']);
      hoja.setFrozenRows(1);
      hoja.getRange(1,1,1,9).setBackground('#334155').setFontColor('#ffffff').setFontWeight('bold');
      try { hoja.setTabColor('#64748b'); } catch(_) {}
    } else {
      const lr = hoja.getLastRow();
      if (lr === 0) {
        hoja.appendRow(['TIMESTAMP_ISO','FECHA_HORA_LOCAL','USERNAME','ROL','TIPO_ACCION','DETALLE_JSON','OPA_AFECTADA','HOJA_AFECTADA','FILA_AFECTADA']);
        hoja.setFrozenRows(1);
        hoja.getRange(1,1,1,9).setBackground('#334155').setFontColor('#ffffff').setFontWeight('bold');
      }
    }
    return hoja;
  } catch(err) {
    return null;
  }
}

function _obtenerHoraLocalISO() {
  try {
    const tz = Session.getScriptTimeZone();
    return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
  } catch(_) { return new Date().toISOString(); }
}

function _sha256Hex(str) {
  try {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      const n = (bytes[i] + 256) % 256;
      out += (n < 16 ? '0' : '') + n.toString(16);
    }
    return out;
  } catch(_) { return ''; }
}

function _generarSalt(len) {
  len = len || 16;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function _buscarUsuarioPorUsername(usernameRaw) {
  try {
    const hoja = _obtenerOHojarUsuarios();
    if (!hoja) return null;
    const usernameQ = String(usernameRaw || '').trim().toLowerCase();
    if (!usernameQ) return null;
    const lr = hoja.getLastRow();
    if (lr <= 1) return null;
    const lc = Math.max(hoja.getLastColumn(), 10);
    const datos = hoja.getRange(2, 1, lr - 1, lc).getDisplayValues() || [];
    for (let i = 0; i < datos.length; i++) {
      const f = datos[i];
      const u = String(f[1] || '').trim().toLowerCase();
      if (u === usernameQ) {
        const rol = String(f[3] || 'USUARIO');
        const permRaw = (f.length >= 10) ? String(f[9] || '') : '';
        return {
          fila: i + 2,
          id: String(f[0] || ''),
          username: String(f[1] || ''),
          nombreCompleto: String(f[2] || ''),
          rol: rol,
          hashPwd: String(f[4] || ''),
          salt: String(f[5] || ''),
          fechaRegistro: String(f[6] || ''),
          ultimoAcceso: String(f[7] || ''),
          correo: String(f[8] || ''),
          permisosJSON: permRaw,
          permisos: _parsePermisos(permRaw, rol)
        };
      }
    }
    return null;
  } catch(err) { return null; }
}

function auditLogMutation(info) {
  try {
    const hoja = _obtenerOHojarHistorial();
    if (!hoja) return false;
    const i = info || {};
    const tsISO = new Date().toISOString();
    const tsLocal = _obtenerHoraLocalISO();
    const json = i.detalleJSON ? (typeof i.detalleJSON === 'string' ? i.detalleJSON : JSON.stringify(i.detalleJSON)) : '';
    hoja.appendRow([
      tsISO, tsLocal,
      String(i.username || 'USUARIO_ANONIMO'),
      String(i.rol || 'USUARIO'),
      String(i.tipoAccion || 'ACCION'),
      json,
      String(i.opaAfectada || ''),
      String(i.hojaAfectada || ''),
      i.filaAfectada ? Number(i.filaAfectada) : ''
    ]);
    return true;
  } catch(err) { return false; }
}

function registerUser(payload) {
  try {
    const p = payload || {};
    const username = String(p.username || '').trim();
    const nombreCompleto = String(p.nombreCompleto || '').trim();
    const correo = String(p.correo || '').trim();
    const hashPwdCliente = String(p.hashPwd || '').trim(); // viene hasheado SHA256 desde cliente (doble hash en server)

    if (!username || username.length < 3) {
      return { ok: false, error: 'Nombre de usuario demasiado corto (mínimo 3 caracteres).' };
    }
    if (!hashPwdCliente || hashPwdCliente.length < 10) {
      return { ok: false, error: 'Contraseña inválida. Intente nuevamente.' };
    }

    const existe = _buscarUsuarioPorUsername(username);
    if (existe) {
      return { ok: false, error: 'Ya existe un usuario con ese nombre. Escoge otro.' };
    }

    const hoja = _obtenerOHojarUsuarios();
    if (!hoja) return { ok: false, error: 'No se pudo acceder a la hoja USUARIOS.' };

    const hayUsuariosPrevios = (hoja.getLastRow() > 1);
    const rol = hayUsuariosPrevios ? 'USUARIO' : 'ADMINISTRADOR'; // El 1ER usuario = ADMIN
    const salt = _generarSalt(20);
    const hashFinal = _sha256Hex(hashPwdCliente + '::' + salt);
    const idUsuario = 'U_' + Math.floor(100000 + Math.random() * 900000);
    const ahoraISO = new Date().toISOString();
    const permisosIniciales = _permisosPorDefecto(rol);

    hoja.appendRow([idUsuario, username, nombreCompleto, rol, hashFinal, salt, ahoraISO, '', correo, JSON.stringify(permisosIniciales)]);
    _limpiarCacheCorta();
    return {
      ok: true,
      rol: rol,
      username: username,
      nombreCompleto: nombreCompleto,
      permisos: permisosIniciales,
      esPrimerUsuario: !hayUsuariosPrevios,
      mensaje: !hayUsuariosPrevios
        ? 'Usuario creado como ADMINISTRADOR (primero en la hoja USUARIOS).'
        : 'Usuario registrado correctamente.'
    };
  } catch(err) {
    return { ok: false, error: err.message || 'Error en el registro.' };
  }
}

function loginUser(payload) {
  try {
    const p = payload || {};
    const username = String(p.username || '').trim();
    const hashPwdCliente = String(p.hashPwd || '').trim();
    if (!username || !hashPwdCliente) {
      return { ok: false, error: 'Faltan credenciales.' };
    }
    const usuario = _buscarUsuarioPorUsername(username);
    if (!usuario) {
      return { ok: false, error: 'Credenciales incorrectas.' };
    }
    const hashCalculado = _sha256Hex(hashPwdCliente + '::' + (usuario.salt || ''));
    if (hashCalculado !== (usuario.hashPwd || '')) {
      auditLogMutation({
        username: usuario.username,
        rol: usuario.rol,
        tipoAccion: 'LOGIN_FALLIDO',
        detalleJSON: JSON.stringify({ motivo: 'hash_mismatch' })
      });
      return { ok: false, error: 'Credenciales incorrectas.' };
    }
    // Actualizar último acceso
    try {
      const hojaUsuarios = _obtenerOHojarUsuarios();
      if (hojaUsuarios && usuario.fila) {
        hojaUsuarios.getRange(usuario.fila, 8).setValue(new Date().toISOString());
      }
    } catch(_) {}
    auditLogMutation({
      username: usuario.username,
      rol: usuario.rol,
      tipoAccion: 'LOGIN_OK'
    });
    // Token de sesión simple (server genera, se devuelve al cliente; cliente lo guarda y lo devuelve en siguientes llamadas)
    const tokenSesion = _sha256Hex('T_' + usuario.username + '_' + new Date().toISOString() + '_' + _generarSalt(8));
    try {
      // GUARDAR EN SCRIPT_PROPERTIES (Global) como Map<token, {...}>. Permite multiples sesiones simultaneas.
      let map = _sesionesLimpiarExpiradas(_sesionesMapLeer());
      map[tokenSesion] = {
        token: tokenSesion,
        username: usuario.username,
        rol: usuario.rol,
        nombreCompleto: usuario.nombreCompleto || '',
        correo: usuario.correo || '',
        ts: new Date().toISOString(),
        expiraMs: 1000 * 60 * 60 * 12
      };
      _sesionesMapGuardar(map);
    } catch(_) {}
    return {
      ok: true,
      token: tokenSesion,
      username: usuario.username,
      nombreCompleto: usuario.nombreCompleto,
      rol: usuario.rol,
      correo: usuario.correo,
      permisos: usuario.permisos || _permisosPorDefecto(usuario.rol)
    };
  } catch(err) {
    return { ok: false, error: err.message || 'Error al iniciar sesión.' };
  }
}

function getCurrentUser(token) {
  try {
    const tk = String(token || '').trim();
    if (!tk) return { ok: false, logueado: false, mensaje: 'Sin sesión activa.' };
    let map = _sesionesLimpiarExpiradas(_sesionesMapLeer());
    try { _sesionesMapGuardar(map); } catch(_) {}
    const sesion = map[tk];
    if (!sesion || !sesion.token) return { ok: false, logueado: false };
    const username = String(sesion.username || '');
    const usuario = username ? _buscarUsuarioPorUsername(username) : null;
    const permisos = (usuario && usuario.permisos) ? usuario.permisos : _permisosPorDefecto(String(sesion.rol || 'USUARIO'));
    return {
      ok: true,
      logueado: true,
      username: sesion.username,
      rol: sesion.rol,
      nombreCompleto: sesion.nombreCompleto || '',
      correo: sesion.correo || '',
      token: tk,
      permisos: permisos
    };
  } catch(err) {
    return { ok: false, logueado: false, error: err.message || 'Error al leer sesión.' };
  }
}

function adminListarPermisos(token) {
  try {
    const s = getCurrentUser(token);
    if (!s || !s.logueado || s.rol !== 'ADMINISTRADOR') {
      return { ok: false, error: 'Acceso denegado. Solo Administrador.' };
    }
    const hoja = _obtenerOHojarUsuarios();
    if (!hoja) return { ok: false, error: 'Sin hoja USUARIOS.' };
    const lr = hoja.getLastRow();
    if (lr <= 1) return { ok: true, listado: [] };
    const lc = Math.max(hoja.getLastColumn(), 10);
    const rows = hoja.getRange(2, 1, lr-1, lc).getDisplayValues() || [];
    const listado = [];
    for (let i=0;i<rows.length;i++) {
      const f = rows[i];
      if (!f[1] || !String(f[1] || '').trim()) continue;
      const rol = String(f[3] || 'USUARIO');
      const permRaw = (f.length >= 10) ? String(f[9] || '') : '';
      listado.push({
        id: String(f[0]||''),
        username: String(f[1]||''),
        nombreCompleto: String(f[2]||''),
        rol: rol,
        correo: String(f[8]||''),
        fechaRegistro: String(f[6]||''),
        ultimoAcceso: String(f[7]||''),
        permisos: _parsePermisos(permRaw, rol)
      });
    }
    return { ok: true, listado: listado };
  } catch(err) { return { ok: false, error: err.message || 'Error al listar permisos.' }; }
}

function adminGuardarPermisos(token, username, permisosObj) {
  try {
    const s = getCurrentUser(token);
    if (!s || !s.logueado || s.rol !== 'ADMINISTRADOR') {
      return { ok: false, error: 'Acceso denegado. Solo Administrador.' };
    }
    const usuario = _buscarUsuarioPorUsername(username);
    if (!usuario || !usuario.fila) return { ok: false, error: 'Usuario no encontrado.' };
    const rol = String(usuario.rol || 'USUARIO');
    const base = _permisosPorDefecto(rol);
    const pObj = permisosObj && typeof permisosObj === 'object' ? permisosObj : {};
    const guardar = {
      ver_dashboard: (typeof pObj.ver_dashboard === 'boolean') ? pObj.ver_dashboard : !!base.ver_dashboard,
      ver_analisis: (typeof pObj.ver_analisis === 'boolean') ? pObj.ver_analisis : !!base.ver_analisis,
      ver_busqueda: (typeof pObj.ver_busqueda === 'boolean') ? pObj.ver_busqueda : !!base.ver_busqueda,
      cambiar_estado: (typeof pObj.cambiar_estado === 'boolean') ? pObj.cambiar_estado : !!base.cambiar_estado,
      panel_admin: (typeof pObj.panel_admin === 'boolean') ? pObj.panel_admin : !!base.panel_admin
    };
    const hoja = _obtenerOHojarUsuarios();
    if (!hoja) return { ok: false, error: 'Sin hoja USUARIOS.' };
    hoja.getRange(usuario.fila, 10).setValue(JSON.stringify(guardar));
    auditLogMutation({
      username: s.username,
      rol: s.rol,
      tipoAccion: 'CAMBIO_PERMISOS',
      detalleJSON: JSON.stringify({
        usuario_objetivo: usuario.username,
        rol_objetivo: rol,
        permisos_antes: usuario.permisos || base,
        permisos_despues: guardar
      })
    });
    return { ok: true, username: usuario.username, permisos: guardar };
  } catch(err) { return { ok: false, error: err.message || 'Error al guardar permisos.' }; }
}

function logoutUser(token) {
  try {
    const tk = String(token || '').trim();
    if (tk) {
      let map = _sesionesLimpiarExpiradas(_sesionesMapLeer());
      if (map[tk]) {
        delete map[tk];
        try { _sesionesMapGuardar(map); } catch(_) {}
      }
    }
    return { ok: true };
  } catch(err) {
    return { ok: false, error: err.message || 'Error al cerrar sesión.' };
  }
}

// Admin: listar usuarios + historial
function adminListarUsuarios(token) {
  try {
    const s = getCurrentUser(token);
    if (!s || !s.logueado || s.rol !== 'ADMINISTRADOR') {
      return { ok: false, error: 'Acceso denegado. Solo Administrador.' };
    }
    const hoja = _obtenerOHojarUsuarios();
    if (!hoja) return { ok: false, error: 'Sin hoja USUARIOS.' };
    const lr = hoja.getLastRow();
    if (lr <= 1) return { ok: true, listado: [] };
    const rows = hoja.getRange(2, 1, lr-1, 9).getDisplayValues() || [];
    const listado = rows.map(function(f){
      return {
        id: String(f[0]||''), username: String(f[1]||''), nombreCompleto: String(f[2]||''),
        rol: String(f[3]||''), fechaRegistro: String(f[6]||''), ultimoAcceso: String(f[7]||''),
        correo: String(f[8]||'')
      };
    });
    return { ok: true, listado: listado };
  } catch(err) { return { ok: false, error: err.message || 'Error al listar usuarios.' }; }
}

function adminListarHistorial(token, limite) {
  try {
    const s = getCurrentUser(token);
    if (!s || !s.logueado || s.rol !== 'ADMINISTRADOR') {
      return { ok: false, error: 'Acceso denegado. Solo Administrador.' };
    }
    const hoja = _obtenerOHojarHistorial();
    if (!hoja) return { ok: false, error: 'Sin hoja HISTORIAL.' };
    const lr = hoja.getLastRow();
    if (lr <= 1) return { ok: true, listado: [] };
    const L = Math.max(20, Math.min(Number(limite) || 500, 5000));
    const desdeFila = Math.max(2, lr - L + 1);
    const rows = hoja.getRange(desdeFila, 1, lr - desdeFila + 1, 9).getDisplayValues() || [];
    const listado = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const f = rows[i];
      listado.push({
        tsISO: String(f[0]||''), tsLocal: String(f[1]||''),
        username: String(f[2]||''), rol: String(f[3]||''), tipoAccion: String(f[4]||''),
        detalleJSON: String(f[5]||''), opaAfectada: String(f[6]||''),
        hojaAfectada: String(f[7]||''), filaAfectada: String(f[8]||'')
      });
    }
    return { ok: true, listado: listado };
  } catch(err) { return { ok: false, error: err.message || 'Error al listar historial.' }; }
}

/* ============================================================
   📋 OBTENER HISTORIAL + ESTADÍSTICAS COMPLETO (NUEVO TAB ADMIN)
   Devuelve:
   - resumenUsuarios: array [{ username, nombreCompleto, rol, totalAcciones,
                                cambioEstado, editarCampo, loginOk, loginFallido,
                                cambioPermisos, opasUnicasTocadas }]
   - listado: rows historial (últimas 2000) ordenado reciente primero
   SOLO ADMINISTRADOR.
============================================================ */
function adminObtenerHistorialYEstadisticas(token) {
  try {
    const s = getCurrentUser(token);
    if (!s || !s.logueado) return { ok: false, error: 'Sesión inválida o cerrada.' };
    if (s.rol !== 'ADMINISTRADOR' && (!s.permisos || s.permisos.panel_admin !== true)) {
      return { ok: false, error: 'Acceso denegado. Solo administradores pueden ver el Historial.' };
    }

    // 1) Cargar lista USUARIOS para cruzar con stats
    const hojaUsr = _obtenerOHojarUsuarios();
    const usuariosMap = {}; // username -> {nombreCompleto, rol, ...}
    try {
      if (hojaUsr && hojaUsr.getLastRow() > 1) {
        const rowsU = hojaUsr.getRange(2, 1, hojaUsr.getLastRow() - 1, Math.max(hojaUsr.getLastColumn(), 10)).getDisplayValues() || [];
        for (let iu = 0; iu < rowsU.length; iu++) {
          const fu = rowsU[iu];
          const usr = String(fu[1] || '').trim();
          if (!usr) continue;
          usuariosMap[usr] = {
            username: usr,
            nombreCompleto: String(fu[2] || '').trim(),
            rol: String(fu[3] || '').trim() || 'USUARIO',
            fechaRegistro: String(fu[6] || '').trim(),
            ultimoAcceso: String(fu[7] || '').trim(),
            correo: String(fu[8] || '').trim()
          };
        }
      }
    } catch(_UsuariosErr) {}

    // 2) Cargar HISTORIAL completo (max 3000 filas para no gastar cuota)
    const hojaHist = _obtenerOHojarHistorial();
    if (!hojaHist) return { ok: false, error: 'Sin hoja HISTORIAL.' };
    const lrH = hojaHist.getLastRow();
    const listado = [];
    // Objeto stats: username -> contadores
    const stats = {};
    function _getOrInit(usr) {
      if (!stats[usr]) {
        const info = usuariosMap[usr] || { username: usr, nombreCompleto: '', rol: 'DESCONOCIDO', fechaRegistro: '', ultimoAcceso: '', correo: '' };
        stats[usr] = {
          username: usr,
          nombreCompleto: info.nombreCompleto || '',
          rol: info.rol || 'USUARIO',
          fechaRegistro: info.fechaRegistro || '',
          ultimoAcceso: info.ultimoAcceso || '',
          correo: info.correo || '',
          totalAcciones: 0,
          cambioEstado: 0,
          editarCampo: 0,
          loginOk: 0,
          loginFallido: 0,
          cambioPermisos: 0,
          registroUsuario: 0,
          otras: 0,
          opasUnicasTocadas: {}  // set-like object (key=numeroOPA)
        };
      }
      return stats[usr];
    }

    if (lrH > 1) {
      const L = Math.min(3000, lrH - 1);
      const desdeFila = lrH - L + 1;
      const rows = hojaHist.getRange(desdeFila, 1, L, 9).getDisplayValues() || [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const f = rows[i];
        const usr = String(f[2] || 'USUARIO_ANONIMO').trim();
        const tipoAccion = String(f[4] || '').trim();
        const opa = String(f[6] || '').trim();
        const obj = {
          tsISO: String(f[0]||''), tsLocal: String(f[1]||''),
          username: usr, rol: String(f[3]||''), tipoAccion: tipoAccion,
          detalleJSON: String(f[5]||''), opaAfectada: opa,
          hojaAfectada: String(f[7]||''), filaAfectada: String(f[8]||'')
        };
        listado.push(obj);
        const st = _getOrInit(usr);
        st.totalAcciones++;
        // Contar por tipo de acción
        if (tipoAccion === 'CAMBIO_ESTADO') st.cambioEstado++;
        else if (tipoAccion === 'EDITAR_CAMPO') st.editarCampo++;
        else if (tipoAccion === 'LOGIN_OK' || tipoAccion === 'INICIO_SESION' || tipoAccion === 'LOGIN') st.loginOk++;
        else if (tipoAccion === 'LOGIN_FALLIDO') st.loginFallido++;
        else if (tipoAccion === 'CAMBIO_PERMISOS') st.cambioPermisos++;
        else if (tipoAccion === 'REGISTRO_USUARIO' || tipoAccion === 'CREAR_USUARIO') st.registroUsuario++;
        else st.otras++;
        // OPAs únicas tocadas (cualquier acción que tenga OPA asociada)
        if (opa) st.opasUnicasTocadas[opa] = true;
      }
    }

    // 3) Convertir stats a array y contar OPAs únicas
    const resumenUsuarios = [];
    for (let k in stats) {
      const r = stats[k];
      const opasKeys = Object.keys(r.opasUnicasTocadas || {});
      const cantidadOPAs = opasKeys ? opasKeys.length : 0;
      resumenUsuarios.push({
        username: r.username,
        nombreCompleto: r.nombreCompleto,
        rol: r.rol,
        fechaRegistro: r.fechaRegistro,
        ultimoAcceso: r.ultimoAcceso,
        correo: r.correo,
        totalAcciones: r.totalAcciones,
        cambioEstado: r.cambioEstado,
        editarCampo: r.editarCampo,
        loginOk: r.loginOk,
        loginFallido: r.loginFallido,
        cambioPermisos: r.cambioPermisos,
        registroUsuario: r.registroUsuario,
        otras: r.otras,
        opasUnicasTocadas: cantidadOPAs
      });
    }
    // Ordenar resumen por totalAcciones DESC
    resumenUsuarios.sort(function(a, b) { return (b.totalAcciones || 0) - (a.totalAcciones || 0); });

    // 4) Totales globales
    let totalCambiosEstado = 0, totalEdicionesCampo = 0, totalOPAs = 0;
    const opasGlobales = {};
    for (let ii = 0; ii < resumenUsuarios.length; ii++) {
      totalCambiosEstado += (resumenUsuarios[ii].cambioEstado || 0);
      totalEdicionesCampo += (resumenUsuarios[ii].editarCampo || 0);
    }
    for (let kk in listado) {
      const o = listado[kk] && listado[kk].opaAfectada ? listado[kk].opaAfectada : '';
      if (o) opasGlobales[o] = true;
    }
    totalOPAs = Object.keys(opasGlobales).length;

    return {
      ok: true,
      resumenUsuarios: resumenUsuarios,
      listado: listado,
      totalesGlobales: {
        totalUsuariosRegistrados: Object.keys(usuariosMap).length,
        totalAccionesSistema: listado.length,
        totalCambiosEstado: totalCambiosEstado,
        totalEdicionesCampo: totalEdicionesCampo,
        totalOPAsTocadas: totalOPAs
      }
    };
  } catch(err) {
    return { ok: false, error: err.message || 'Error al obtener historial y estadísticas.' };
  }
}

/* ============================================================
   ✏️ CAMBIAR ESTADO DE OPA DESDE BUSQUEDA OPA
   2 NIVELES DE ROBUSTEZ:
   1) FILA: No se fía solo de payload.fila → BUSCA NUMERO DE OPA DIRECTAMENTE en columna O
   2) COLUMNA FECHA: No solo usa IDX[F#] → RE-RECORRE header completo con REGEX (mayúsculas/minúsculas/acentos NO importan)
   Guarda: Estado Plataforma (col E) + Fecha etapa según etapa del flujo
   Registra CAMBIO_ESTADO en HISTORIAL_AUDITORIA
============================================================ */
function cambiarEstadoOPA(payload) {
  try {
    const tk = String(payload && payload.token || '').trim();
    const s = getCurrentUser(tk);
    if (!s || !s.logueado) return { ok: false, error: 'Sesión no válida o expirada. Inicia sesión de nuevo.' };
    if (!s.permisos || s.permisos.cambiar_estado !== true) {
      return { ok: false, error: 'No tienes permiso para cambiar estados.' };
    }
    const nombreHoja = String(payload.hoja || '').trim() || String(payload.nombreHoja || '').trim();
    const filaRecomendada = Number(payload.fila);
    const nuevoEstado = String(payload.nuevoEstado || '').trim();
    const fechaElegida = String(payload.fechaElegida || '').trim();
    const opaNumero = String(payload.numeroOPA || String(payload.opa || '').trim()).trim();
    if (!nombreHoja) return { ok:false, error: 'Falta nombre de Hoja.' };
    if (!opaNumero) return { ok: false, error: 'Falta número de OPA para ubicar la fila correctamente.' };
    if (!nuevoEstado) return { ok: false, error: 'Selecciona un nuevo estado.' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hoja = ss.getSheetByName(nombreHoja);
    if (!hoja) return { ok: false, error: 'La hoja "' + nombreHoja + '" ya no existe en el libro.' };

    const lr = hoja.getLastRow();
    const lc = Math.max(hoja.getLastColumn(), 20);
    if (lr <= 1 || lc <= 0) return { ok: false, error: 'La hoja está vacía.' };

    // 1) Header + normalizar cada columna
    let header = null;
    try { header = hoja.getRange(1, 1, 1, lc).getDisplayValues()[0] || []; } catch(_) { header = []; }
    const aliasH = header.map(function(c){ return normalizarEncabezado(c); });

    // -----------------------------------------------------------
    // PASO 1: ENCONTRAR FILA CORRECTA → MATCH POR NÚMERO DE OPA (columna O)
    //   Primero intentamos fila recomendada + validar que OPA coincida.
    //   Si no coincide o está vacía → recorrer todas las filas.
    // -----------------------------------------------------------
    if (typeof aliasH.indexOf('numerodeopa') < 0) {
      // Buscar columna OPA flexible: cualquier header que contenga "opa" y no sea subopa
      let idxOPA = -1;
      for (let cc=0;cc<aliasH.length;cc++) {
        const ah = aliasH[cc];
        if (/opa/.test(ah) && !/sub/.test(ah)) { idxOPA = cc; break; }
      }
      if (idxOPA < 0) {
        // Último fallback: usar MAPEO_CAMPOS_GLOBAL O
        for (let ic=0; ic<MAPEO_CAMPOS_GLOBAL.length; ic++) {
          if (MAPEO_CAMPOS_GLOBAL[ic].clave === 'O') {
            const aliasLst = MAPEO_ALIAS_GLOBAL[MAPEO_CAMPOS_GLOBAL[ic].nombre] || [];
            for (let al=0; al<aliasLst.length; al++) {
              const p = aliasH.indexOf(aliasLst[al]);
              if (p >= 0) { idxOPA = p; break; }
            }
            if (idxOPA >= 0) break;
          }
        }
      }
      if (idxOPA >= 0) aliasH.push(''); // placeholder (no usamos)
    }
    // Construir IDX robusto con MAPEO_CAMPOS_GLOBAL
    const IDX = {};
    for (let ic=0; ic<MAPEO_CAMPOS_GLOBAL.length; ic++) {
      const campo = MAPEO_CAMPOS_GLOBAL[ic];
      const aliasLst = MAPEO_ALIAS_GLOBAL[campo.nombre] || [normalizarEncabezado(campo.nombre)];
      for (let al=0; al<aliasLst.length; al++) {
        const pos = aliasH.indexOf(aliasLst[al]);
        if (pos >= 0) { IDX[campo.clave] = pos; break; }
      }
    }
    // Buscar col OPA definitiva
    let colOPA = -1;
    if (typeof IDX['O'] !== 'undefined') colOPA = IDX['O'];
    if (colOPA < 0) {
      for (let cc=0; cc<aliasH.length; cc++) {
        const ah = aliasH[cc];
        if ((/numero/.test(ah) || /num/.test(ah)) && /opa/.test(ah) && !/sub/.test(ah)) { colOPA = cc; break; }
        if (colOPA < 0 && /^opa$/.test(ah)) { colOPA = cc; }
      }
    }
    if (colOPA < 0) return { ok: false, error: 'Hoja sin columna Número de OPA detectada.' };

    // Encontrar fila: primero fila recomendada si la OPA coincide. Sino for loop completo.
    let filaRaw = -1;
    const opaBuscar = normalizarEncabezado(opaNumero);
    if (filaRecomendada >= 2 && filaRecomendada <= lr) {
      try {
        const valor = normalizarEncabezado(String(hoja.getRange(filaRecomendada, colOPA + 1).getDisplayValue() || '').trim());
        if (valor && valor === opaBuscar) filaRaw = filaRecomendada;
      } catch(_) { filaRaw = -1; }
    }
    if (filaRaw < 0) {
      // Recorrer TODAS las filas para encontrar la OPA
      const datosColOPA = hoja.getRange(2, colOPA + 1, lr - 1, 1).getDisplayValues() || [];
      for (let ir = 0; ir < datosColOPA.length; ir++) {
        const v = normalizarEncabezado(String(datosColOPA[ir][0] || '').trim());
        if (v && v === opaBuscar) { filaRaw = ir + 2; break; }
      }
    }
    if (filaRaw < 2) return { ok: false, error: 'No se encontró la OPA ' + opaNumero + ' en la hoja. Puede haber sido eliminada.' };

    // Columna E (ESTADO PLATAFORMA) también robusta
    let colEstado = -1;
    if (typeof IDX['E'] !== 'undefined') colEstado = IDX['E'];
    if (colEstado < 0) {
      for (let cc=0; cc<aliasH.length; cc++) {
        const ah = aliasH[cc];
        if (/estado\s*plataforma/.test(ah) || /estadoplataforma/.test(ah) || /^estado\s*plataforma$/.test(ah)) { colEstado = cc; break; }
        if (colEstado < 0 && /estado/.test(ah) && /plataform/.test(ah)) { colEstado = cc; }
      }
    }
    if (colEstado < 0) return { ok: false, error: 'Hoja sin columna ESTADO PLATAFORMA.' };

    const estadoAnterior = String(hoja.getRange(filaRaw, colEstado + 1).getDisplayValue() || '').trim();
    // Escribir nuevo estado
    hoja.getRange(filaRaw, colEstado + 1).setValue(nuevoEstado);

    // ============================================================
    //   MAPEO DIRECTO Y FIJO: 9 ESTADOS del DASHBOARD → COLUMNA FECHA
    // ============================================================
    const nEst = normalizarEncabezado(nuevoEstado);
    let claveColFecha = null;
    let patronColumna = null; // regex para buscar el header si IDX[clave] no funciona
    if (/concepto\s*enviad/.test(nEst)) {
      claveColFecha = 'F1'; patronColumna = /concepto\s*enviad/;
    } else if (/concepto\s*aprobad/.test(nEst)) {
      claveColFecha = 'F2'; patronColumna = /concepto\s*aprobad/;
    } else if (/pre[\s-]*producci[\sóo]*n\s*enviad/.test(nEst) || /preproduccion\s*enviad/.test(nEst)) {
      claveColFecha = 'F3'; patronColumna = /pre[\s-]*producci[\sóo]*n\s*enviad|preproduccion\s*enviad/;
    } else if (/pre[\s-]*producci[\sóo]*n\s*aprobad/.test(nEst) || /preproduccion\s*aprobad/.test(nEst)) {
      claveColFecha = 'F4'; patronColumna = /pre[\s-]*producci[\sóo]*n\s*aprobad|preproduccion\s*aprobad/;
    } else if (/fotos?\s*(de\s*)?producci[\sóo]*n\s*enviad/.test(nEst) || /fotos?\s*(de\s*)?producion\s*enviad/.test(nEst) || /fotograf[\sí]*a\s*enviad/.test(nEst) || /producci[\sóo]*n\s*enviad/.test(nEst) || /producion\s*enviad/.test(nEst)) {
      claveColFecha = 'F5'; patronColumna = /fotos?\s*(de\s*)?producci[\sóo]*n\s*enviad|fotos?\s*(de\s*)?producion\s*enviad|fotograf[\sí]*a\s*enviad|producci[\sóo]*n\s*enviad|producion\s*enviad|fotosdeproducionenviada|fotosdeproduccionenviada/;
    } else if (/fotos?\s*(de\s*)?producci[\sóo]*n\s*aprobad/.test(nEst) || /fotos?\s*(de\s*)?producion\s*aprobad/.test(nEst) || /fotograf[\sí]*a\s*aprobad/.test(nEst) || /producci[\sóo]*n\s*aprobad/.test(nEst) || /producion\s*aprobad/.test(nEst)) {
      claveColFecha = 'F6'; patronColumna = /fotos?\s*(de\s*)?producci[\sóo]*n\s*aprobad|fotos?\s*(de\s*)?producion\s*aprobad|fotograf[\sí]*a\s*aprobad|producci[\sóo]*n\s*aprobad|producion\s*aprobad|fotosdeproducionaprobada|fotosdeproduccionaprobada/;
    } else if (/muestras?\s*finales\s*enviad/.test(nEst) || /aprobaci[\sóo]*n\s*final\s*enviad/.test(nEst) || /env[\sí]*o\s*op\s*a?\s*client/.test(nEst)) {
      claveColFecha = 'F7'; patronColumna = /muestras?\s*finales\s*enviad|aprobaci[\sóo]*n\s*final\s*enviad/;
    } else if (/aprobada[\s\/\\&y]*cerrada/.test(nEst) || /aprobaci[\sóo]*n\s*final\s*aprobad/.test(nEst) || /aprobada\s*y\s*cerrada/.test(nEst)) {
      claveColFecha = 'F8'; patronColumna = /aprobada[\s\/\\&y]*cerrada|aprobaci[\sóo]*n\s*final\s*aprobad/;
    } else if (/cancelad/.test(nEst)) {
      claveColFecha = null; patronColumna = null;
    }

    // ============================================================
    // PASO 2: ENCONTRAR COLUMNA FECHA CORRECTA
    //   Nivel A) IDX[claveColFecha] del MAPEO_CAMPOS_GLOBAL
    //   Nivel B) BUSCAR POR REGEX PATRÓN recorriendo aliasH (normalizado)
    //   Nivel C) BUSCAR HEADER ORIGINAL texto tal cual tu Excel (case/acentos insensitive)
    //   Nivel D) PALABRAS CLAVE requeridas (F5 = foto+prod+envi...)
    //   Nivel E) Fallback general: columna F
    // ============================================================
    let colFecha = -1;
    if (claveColFecha && typeof IDX[claveColFecha] !== 'undefined') {
      colFecha = IDX[claveColFecha] + 1;
    }
    // Nivel B: búsqueda por regex (patrones MUY abarcativos alias sin espacios)
    if (colFecha < 1 && patronColumna) {
      for (let cc=0; cc<aliasH.length; cc++) { if (patronColumna.test(aliasH[cc] || '')) { colFecha = cc + 1; break; } }
    }
    // Nivel C) BUSQUEDA HEADER ORIGINAL texto tal cual tu Excel
    if (colFecha < 1 && claveColFecha) {
      const buscarHeaderRaw = {
        'F1': ['Concepto Enviado', 'CONCEPTO ENVIADO'],
        'F2': ['Concepto Aprobado', 'CONCEPTO APROBADO'],
        'F3': ['Pre-Produccion Enviada', 'Pre Produccion Enviada', 'PREPRODUCCION ENVIADA'],
        'F4': ['Pre-Produccion Aprobada', 'Pre Produccion Aprobada', 'PREPRODUCCION APROBADA'],
        'F5': ['Fotos de produccion enviada', 'Fotos Produccion Enviada', 'FOTOS DE PRODUCCION ENVIADA', 'Fotos Enviadas Produccion'],
        'F6': ['Fotos de producion aprobada', 'Fotos Produccion Aprobada', 'FOTOS DE PRODUCCION APROBADA', 'Fotos Aprobada Produccion'],
        'F7': ['Muestras Finales Enviadas', 'MUESTRAS FINALES ENVIADAS'],
        'F8': ['Aprobada / Cerrada', 'Aprobada/Cerrada', 'Aprobada y Cerrada', 'APROBADA CERRADA'],
        'FM': ['Fecha Envio Muestras', 'Fecha de Envio de Muestras']
      };
      const listaBusc = buscarHeaderRaw[claveColFecha] || [];
      for (let bi=0; bi<listaBusc.length; bi++) {
        const txtBuscar = String(listaBusc[bi]).toLowerCase();
        for (let cc=0; cc<header.length; cc++) {
          const valorHeader = String(header[cc] || '').toLowerCase();
          if (!valorHeader) continue;
          if (valorHeader.indexOf(txtBuscar) >= 0 || txtBuscar.indexOf(valorHeader) >= 0) {
            var ocupada = false;
            for (var kkk in IDX) if (IDX[kkk] === cc) { ocupada = true; break; }
            if (!ocupada) { colFecha = cc + 1; break; }
          }
        }
        if (colFecha > 0) break;
      }
    }
    // Nivel D) PALABRAS CLAVE requeridas
    if (colFecha < 1 && claveColFecha) {
      const requeridos = {
        'F1': ['concep', 'envi'],
        'F2': ['concep', 'apro'],
        'F3': ['pre', 'prod', 'envi'],
        'F4': ['pre', 'prod', 'apro'],
        'F5': ['foto', 'prod', 'envi'],
        'F6': ['foto', 'prod', 'apro'],
        'F7': ['muestr', 'final', 'envi'],
        'F8': ['aprob', 'cerr'],
        'FM': ['envio', 'muestr']
      };
      const req = requeridos[claveColFecha] || [];
      if (req.length) {
        for (let cc=0; cc<header.length; cc++) {
          const vh = String(header[cc] || '').toLowerCase();
          if (!vh) continue;
          var todos = true;
          for (let rr=0; rr<req.length; rr++) { if (vh.indexOf(req[rr]) < 0) { todos = false; break; } }
          if (!todos) continue;
          var ocup = false;
          for (var k2 in IDX) if (IDX[k2] === cc) { ocup = true; break; }
          if (!ocup) { colFecha = cc + 1; break; }
        }
      }
    }
    // Nivel E) Fallback columna F general
    if (colFecha < 1 && typeof IDX['F'] !== 'undefined') colFecha = IDX['F'] + 1;

    let fechaEscrita = null;
    if (colFecha > 0 && fechaElegida) {
      // Intentar escribir como fecha
      let d = null;
      try { d = new Date(fechaElegida); } catch(_) { d = null; }
      // Intentar parse dd/mm/aaaa
      if ((!d || isNaN(d.getTime())) && fechaElegida.indexOf('/') > -1) {
        const partes = fechaElegida.split('/');
        if (partes.length === 3) {
          const dia = Number(partes[0]);
          const mes = Number(partes[1]) - 1;
          let anio = Number(partes[2]);
          if (anio < 100) anio = anio + 2000;
          d = new Date(anio, mes, dia);
        }
      }
      if (d && !isNaN(d.getTime())) {
        hoja.getRange(filaRaw, colFecha).setValue(d);
        fechaEscrita = d;
      } else if (fechaElegida) {
        hoja.getRange(filaRaw, colFecha).setValue(fechaElegida);
        fechaEscrita = fechaElegida;
      }
    }
    // Registrar auditoria
    auditLogMutation({
      username: s.username,
      rol: s.rol,
      tipoAccion: 'CAMBIO_ESTADO',
      detalleJSON: JSON.stringify({
        estadoAnterior: estadoAnterior,
        estadoNuevo: nuevoEstado,
        fechaElegida: fechaElegida,
        filaEncontradaPor: (filaRaw === filaRecomendada ? 'fila_recomendada_validada' : 'busqueda_por_numero_OPA'),
        columnaFechaEstrategia: claveColFecha + '|idx_ok:' + (typeof IDX[claveColFecha || ''] !== 'undefined' ? 'SI' : 'NO') + '|patron_regex_ok:' + (patronColumna ? 'SI' : 'NO'),
        columnaFechaEscrita: colFecha > 0 ? ('#' + colFecha + ' → ' + String(header[colFecha - 1] || '')) : '',
        valorFecha: fechaEscrita ? (fechaEscrita.toISOString ? fechaEscrita.toISOString() : String(fechaEscrita)) : null
      }),
      opaAfectada: opaNumero,
      hojaAfectada: nombreHoja,
      filaAfectada: filaRaw
    });
    // Invalidar cache checksums para que el dashboard recargue datos automaticamente
    try {
      const sp = PropertiesService.getScriptProperties();
      try { sp.deleteProperty('DASHBOARD_ETAG_V1'); } catch(_) {}
      try { sp.deleteProperty('DASHBOARD_CACHE_V1'); } catch(_) {}
    } catch(_) {}
    return {
      ok: true,
      hoja: nombreHoja,
      fila: filaRaw,
      filaEncontradaPor: (filaRaw === filaRecomendada ? 'validada' : 'busqueda_numero_OPA'),
      estadoAnterior: estadoAnterior,
      estadoNuevo: nuevoEstado,
      columnaFechaUsada: colFecha > 0 ? ('#' + colFecha + ' ' + String(header[colFecha - 1] || '')) : '(sin fecha etapa)',
      fechaEscrita: fechaEscrita ? (fechaEscrita instanceof Date ? Utilities.formatDate(fechaEscrita, Session.getScriptTimeZone(), 'dd/MM/yyyy') : String(fechaEscrita)) : null
    };
  } catch(err) {
    return { ok: false, error: err.message || 'Error al cambiar estado.' };
  }
}


/* ============================================================
   ✏️ EDITAR CAMPO INDIVIDUAL DE UNA OPA (Lápiz en Búsqueda OPA)
   2 NIVELES DE ROBUSTEZ (IGUAL que cambiarEstadoOPA):
   1) FILA: Buscar por NÚMERO DE OPA real en columna O, validando la fila cliente
   2) COLUMNA: Buscar por MAPEO + PATRÓN REGEX sobre header normalizado
============================================================ */
function editarCampoOPA(token, nombreHoja, filaCliente, campoClave, nuevoValor) {
  try {
    // 1) Validar sesión + permiso (MISMO patrón que cambiarEstadoOPA)
    const s = getCurrentUser(token);
    if (!s || !s.logueado) return { ok: false, error: 'Sesión inválida o cerrada. Inicia sesión de nuevo.' };
    if (!s.permisos || s.permisos.cambiar_estado !== true) {
      return { ok: false, error: 'No tienes permiso para editar campos.' };
    }

    nombreHoja = String(nombreHoja || '').trim();
    const filaRecomendada = Number(filaCliente) || 0;
    campoClave = String(campoClave || '').trim();
    nuevoValor = (nuevoValor === null || nuevoValor === undefined) ? '' : String(nuevoValor);

    if (!nombreHoja) return { ok: false, error: 'Hoja es requerida.' };
    if (!campoClave) return { ok: false, error: 'Campo es requerido.' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hoja = ss.getSheetByName(nombreHoja);
    if (!hoja) return { ok: false, error: 'Hoja no encontrada.' };

    const lc = Math.max(hoja.getLastColumn(), 20);
    const lr = hoja.getLastRow();
    if (lc <= 0 || lr <= 1) return { ok: false, error: 'Hoja vacía.' };

    // 2) Header normalizado
    const header = hoja.getRange(1, 1, 1, lc).getDisplayValues()[0] || [];
    const aliasEncabezados = header.map(function(c){ return normalizarEncabezado(c); });
    const IDX = {};
    for (let ic=0; ic<MAPEO_CAMPOS_GLOBAL.length; ic++) {
      const campo = MAPEO_CAMPOS_GLOBAL[ic];
      const aliasLst = MAPEO_ALIAS_GLOBAL[campo.nombre] || [normalizarEncabezado(campo.nombre)];
      for (let al=0; al<aliasLst.length; al++) {
        const pos = aliasEncabezados.indexOf(aliasLst[al]);
        if (pos >= 0) { IDX[campo.clave] = pos; break; }
      }
    }

    // ============================================================
    // PASO 1: BUSCAR FILA POR NÚMERO DE OPA (no fiarse solo de fila cliente
    // ============================================================
    let colOPA = -1;
    if (typeof IDX['O'] !== 'undefined') colOPA = IDX['O'];
    if (colOPA < 0) {
      for (let cc=0; cc<aliasEncabezados.length; cc++) {
        const ah = aliasEncabezados[cc];
        if (((/numero/.test(ah) || /num/.test(ah)) && /opa/.test(ah) && !/sub/.test(ah))) { colOPA = cc; break; }
        if (colOPA < 0 && /^opa$/.test(ah)) { colOPA = cc; }
      }
    }
    let filaFinal = -1;
    let opaNumero = '';
    if (colOPA >= 0 && filaRecomendada >= 2 && filaRecomendada <= lr) {
      try {
        opaNumero = String(hoja.getRange(filaRecomendada, colOPA + 1).getDisplayValue() || '').trim();
        if (opaNumero) filaFinal = filaRecomendada;
      } catch(_) { filaFinal = -1; opaNumero = ''; }
    }
    if (filaFinal < 2 && colOPA >= 0) {
      const c = hoja.getRange(2, colOPA + 1, lr - 1, 1).getDisplayValues() || [];
      for (let ir = 0; ir < c.length; ir++) {
        const v = String(c[ir][0] || '').trim();
        if (v) {
          if (filaRecomendada >= 2 && (ir + 2) === filaRecomendada) { filaFinal = ir + 2; opaNumero = v; break; }
          if (filaFinal < 2) { filaFinal = ir + 2; opaNumero = v; }
        }
      }
    }
    if (filaFinal < 2) filaFinal = Math.max(2, filaRecomendada);

    // ============================================================
    // PASO 2: RESOLVER COLUMNA
    // Niveles: A) IDX[clave] → B) PATRÓN REGEX campoClave F1..F8 → C) MAPEO aliases
    //          D) BUSQUEDA HEADER ORIGINAL texto tal cual tu Excel (case insensitive)
    //          E) CASO ESPECIAL nos dice el usuario: F5 = T / F6 = U detectados por texto exacto
    // ============================================================
    let col = -1;
    if (typeof IDX[campoClave] !== 'undefined') {
      col = IDX[campoClave] + 1;
    } else {
      // B) Patrón por tipo campo (REGEX MUY abarcativo: alias sin espacios)
      const nClave = normalizarEncabezado(campoClave);
      const patronesColumna = {
        'F1': /CONCEPTO.*ENVIAD|ENVIAD.*CONCEPTO/i,
        'F2': /CONCEPTO.*APROBAD|APROBAD.*CONCEPTO/i,
        'F3': /PRE.*PROD.*ENVIA|PREPROD.*ENVIA|ENVIA.*PREPROD/i,
        'F4': /PRE.*PROD.*APROB|PREPROD.*APROB|APROB.*PREPROD/i,
        'F5': /FOTOS.*PROD.*ENV|PROD.*ENV.*FOTOS|FOTOSDEPRODUCIONENVIADA|FOTOSDEPRODUCCIONENVIADA|FOTOSPROD.*ENVIAD|FOTODEPROD.*ENVIAD/i,
        'F6': /FOTOS.*PROD.*APROB|PROD.*APROB.*FOTOS|FOTOSDEPRODUCIONAPROBADA|FOTOSDEPRODUCCIONAPROBADA|FOTOSPROD.*APROBAD|FOTODEPROD.*APROBAD/i,
        'F7': /MUESTRA.*FINAL.*ENVIA|FINAL.*MUESTRA.*ENVIAD|APROBACIONFINALENVIAD/i,
        'F8': /APROBADA.*CERRADA|CERRADA.*APROBADA|APROBACIONFINALAPROBAD/i,
        'FM': /ENVIO.*MUESTR|MUESTRA.*ENVIO|FECHAMUESTRA/i,
        'P': /PROYECT/i,
        'T': /TIPOPRODUCTO|TIPO\s*PRODUCTO|^TIPO$/i,
        'TE': /ESPECIFICO/i,
        'M': /MARCA/i,
        'TR': /TERRITORIO/i,
        'PJ': /PERSONAJE/i,
        'SO': /SUBOPA|SUB[\s-]*OPA/i,
        'E': /ESTADOPLATAFORMA|ESTADO\s*PLATAFORMA/i,
        'F': /FECHA/i,
        'O': /NUMERODEOPA|NUMERO\s*OPA|^OPA$/i
      };
      const patron = patronesColumna[campoClave] || null;
      if (patron) {
        for (let cc=0; cc<aliasEncabezados.length; cc++) { if (patron.test(aliasEncabezados[cc] || '')) { col = cc + 1; break; } }
      }
      // C) Fallback: MAPEO_CAMPOS_GLOBAL aliases indexOf
      if (col < 0) {
        for (let ic=0; ic<MAPEO_CAMPOS_GLOBAL.length; ic++) {
          const campo = MAPEO_CAMPOS_GLOBAL[ic];
          if (normalizarEncabezado(campo.clave) === nClave) {
            const aliasLst = MAPEO_ALIAS_GLOBAL[campo.nombre] || [];
            for (let al=0; al<aliasLst.length; al++) {
              const p = aliasEncabezados.indexOf(aliasLst[al]);
              if (p >= 0) { col = p + 1; break; }
            }
          }
          if (col > 0) break;
        }
      }
      // D) BUSQUEDA HEADER ORIGINAL (sin normalizar, texto tal cual tu Excel, case & accent insensitive)
      //    Ideal para columnas con nombre exacto como "Fotos de produccion enviada"
      if (col < 0) {
        // Map campoClave → textos que BUSCAMOS en el header ORIGINAL (varios posibles)
        const buscarHeaderRaw = {
          'F1': ['Concepto Enviado', 'CONCEPTO ENVIADO'],
          'F2': ['Concepto Aprobado', 'CONCEPTO APROBADO'],
          'F3': ['Pre-Produccion Enviada', 'Pre Produccion Enviada', 'PREPRODUCCION ENVIADA'],
          'F4': ['Pre-Produccion Aprobada', 'Pre Produccion Aprobada', 'PREPRODUCCION APROBADA'],
          'F5': ['Fotos de produccion enviada', 'Fotos Produccion Enviada', 'FOTOS DE PRODUCCION ENVIADA', 'Fotos Enviadas Produccion'],
          'F6': ['Fotos de producion aprobada', 'Fotos Produccion Aprobada', 'FOTOS DE PRODUCCION APROBADA', 'Fotos Aprobada Produccion'],
          'F7': ['Muestras Finales Enviadas', 'MUESTRAS FINALES ENVIADAS'],
          'F8': ['Aprobada / Cerrada', 'Aprobada/Cerrada', 'Aprobada y Cerrada', 'APROBADA CERRADA'],
          'FM': ['Fecha Envio Muestras', 'Fecha de Envio de Muestras']
        };
        const listaBusc = buscarHeaderRaw[campoClave] || [];
        for (let bi=0; bi<listaBusc.length; bi++) {
          const txtBuscar = String(listaBusc[bi]).toLowerCase();
          for (let cc=0; cc<header.length; cc++) {
            const valorHeader = String(header[cc] || '').toLowerCase();
            if (!valorHeader) continue;
            if (valorHeader.indexOf(txtBuscar) >= 0 || txtBuscar.indexOf(valorHeader) >= 0) {
              // evitar columna ocupada
              var ocupada = false;
              for (var kkk in IDX) if (IDX[kkk] === cc) { ocupada = true; break; }
              if (!ocupada) { col = cc + 1; break; }
            }
          }
          if (col > 0) break;
        }
      }
      // E) FALLBACK ULTIMO recorrido por palabras clave (F5=FOTOS+PROD+ENV, F6=FOTOS+PROD+APROB)
      if (col < 0 && /^F[1-8]$|^FM$/.test(campoClave)) {
        const requeridos = {
          'F1': ['concep', 'envi'],
          'F2': ['concep', 'apro'],
          'F3': ['pre', 'prod', 'envi'],
          'F4': ['pre', 'prod', 'apro'],
          'F5': ['foto', 'prod', 'envi'],
          'F6': ['foto', 'prod', 'apro'],
          'F7': ['muestr', 'final', 'envi'],
          'F8': ['aprob', 'cerr'],
          'FM': ['envio', 'muestr']
        };
        const req = requeridos[campoClave] || [];
        if (req.length) {
          for (let cc=0; cc<header.length; cc++) {
            const vh = String(header[cc] || '').toLowerCase();
            if (!vh) continue;
            var todos = true;
            for (let rr=0; rr<req.length; rr++) { if (vh.indexOf(req[rr]) < 0) { todos = false; break; } }
            if (!todos) continue;
            var ocup = false;
            for (var k2 in IDX) if (IDX[k2] === cc) { ocup = true; break; }
            if (!ocup) { col = cc + 1; break; }
          }
        }
      }
    }
    if (col < 1) return { ok: false, error: 'Columna ' + campoClave + ' no existe en la hoja (no se detectó el encabezado correctamente). Asegúrate que el nombre del encabezado en el Excel corresponda a la etapa.' };

    // 3) Obtener valor anterior para auditoría
    let valorAnterior = '';
    try { valorAnterior = String(hoja.getRange(filaFinal, col).getDisplayValue() || '').trim(); } catch(_) {}

    // 4) Escribir nuevo valor. Si parece fecha (campo F* o FM y es dd/mm/aaaa) intentar parsear como Date
    const esCampoFecha = /^F[1-8]$/.test(campoClave) || campoClave === 'FM' || campoClave === 'F';
    let valorEscrito = nuevoValor;
    if (esCampoFecha && nuevoValor) {
      let d = null;
      try { d = new Date(nuevoValor); } catch(_) { d = null; }
      if ((!d || isNaN(d.getTime())) && nuevoValor.indexOf('/') > -1) {
        const partes = nuevoValor.split('/');
        if (partes.length === 3) {
          const dia = Number(partes[0]);
          const mes = Number(partes[1]) - 1;
          let anio = Number(partes[2]);
          if (anio < 100) anio = anio + 2000;
          d = new Date(anio, mes, dia);
        }
      }
      if (d && !isNaN(d.getTime())) {
        hoja.getRange(filaFinal, col).setValue(d);
        valorEscrito = d;
      } else {
        hoja.getRange(filaFinal, col).setValue(nuevoValor);
      }
    } else {
      hoja.getRange(filaFinal, col).setValue(nuevoValor);
    }

    // 5) Auditoría
    if (!opaNumero && colOPA >= 0) {
      try { opaNumero = String(hoja.getRange(filaFinal, colOPA + 1).getDisplayValue() || '').trim(); } catch(_) {}
    }
    auditLogMutation({
      username: s.username,
      rol: s.rol,
      tipoAccion: 'EDITAR_CAMPO',
      detalleJSON: JSON.stringify({
        campo: campoClave,
        filaRecomendadaCliente: filaRecomendada,
        filaFinalEscrita: filaFinal,
        columnaEncontradaPor: (typeof IDX[campoClave] !== 'undefined' ? 'mapeo_directo' : 'patron_regex_header'),
        nombreColumna: header[col - 1] || '',
        valorAnterior: valorAnterior,
        valorNuevo: valorEscrito instanceof Date ? Utilities.formatDate(valorEscrito, Session.getScriptTimeZone(), 'dd/MM/yyyy') : String(valorEscrito || '')
      }),
      opaAfectada: opaNumero,
      hojaAfectada: nombreHoja,
      filaAfectada: filaFinal
    });

    // 6) Invalidar cache
    try {
      const sp = PropertiesService.getScriptProperties();
      try { sp.deleteProperty('DASHBOARD_ETAG_V1'); } catch(_) {}
      try { sp.deleteProperty('DASHBOARD_CACHE_V1'); } catch(_) {}
    } catch(_) {}

    return {
      ok: true,
      nombreHoja: nombreHoja,
      fila: filaFinal,
      filaEncontradaPor: filaFinal === filaRecomendada ? 'validada' : 'busqueda_numero_OPA',
      campo: campoClave,
      nombreColumna: header[col - 1] || '',
      valorAnterior: valorAnterior,
      valorNuevo: valorEscrito instanceof Date ? Utilities.formatDate(valorEscrito, Session.getScriptTimeZone(), 'dd/MM/yyyy') : String(valorEscrito || '')
    };
  } catch(err) {
    return { ok: false, error: err.message || 'Error al editar campo.' };
  }
}


/* ============================================================
   🔎 BÚSQUEDA DE OPA EN CUALQUIER HOJA DEL LIBRO
   Devuelve: { ok:true, resultados:[ { hoja, fila, numeroOPA, estadoPlataforma, proyecto, territorio, fechaUltima, todasLasFechas:{} } ] }
============================================================ */

function searchOPAByNumber(q) {
  try {
    const query = String(q || '').trim().toLowerCase();
    if (!query || query.length < 2) {
      return { ok: false, error: 'Ingresa al menos 2 caracteres para buscar.' };
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hojas = ss.getSheets();
    const resultados = [];

    for (let ih = 0; ih < hojas.length; ih++) {
      const hoja = hojas[ih];
      const nombreHoja = hoja.getName();
      // Omitir hojas del sistema (USUARIOS, HISTORIAL) para no confundir
      if (nombreHoja === NOMBRE_HOJA_USUARIOS || nombreHoja === NOMBRE_HOJA_HISTORIAL) continue;

      const lr = hoja.getLastRow();
      const lc = hoja.getLastColumn();
      if (lr <= 1 || lc <= 0) continue;

      // 1) Construir Mapeo columnas (MISMO algoritmo robusto que obtenerDatosDashboard: paso exacto + fuzzy bidireccional)
      let header = null;
      try { header = hoja.getRange(1, 1, 1, lc).getDisplayValues()[0] || []; } catch(_) { header = []; }
      const IDX = {};
      const aliasEncabezados = header.map(function(c){ return normalizarEncabezado(c); });
      // --- Paso 1: matching EXACTO ---
      for (let ic=0; ic<MAPEO_CAMPOS_GLOBAL.length; ic++) {
        const campo = MAPEO_CAMPOS_GLOBAL[ic];
        const aliasLst = MAPEO_ALIAS_GLOBAL[campo.nombre] || [normalizarEncabezado(campo.nombre)];
        for (let al=0; al<aliasLst.length; al++) {
          const pos = aliasEncabezados.indexOf(aliasLst[al]);
          if (pos >= 0 && !(campo.clave in IDX)) { IDX[campo.clave] = pos; break; }
        }
      }
      // --- Paso 2: matching FUZZY bidireccional (mismo algoritmo que obtenerDatosDashboard) ---
      try {
        var aliasList = [];
        for (var alKey in MAPEO_ALIAS_GLOBAL) {
          aliasList.push([alKey, MAPEO_ALIAS_GLOBAL[alKey]]);
        }
        aliasList.sort(function(a,b){ return b[0].length - a[0].length; });
        for (var akk = 0; akk < aliasList.length; akk++) {
          var aliasNom = aliasList[akk][0];
          var aliasClv = aliasList[akk][1];
          if (!aliasNom || aliasNom.length < 3) continue;
          if (aliasClv in IDX) continue;
          for (var ci2 = 0; ci2 < aliasEncabezados.length; ci2++) {
            var encN = aliasEncabezados[ci2];
            if (!encN || encN.length < 3) continue;
            var yaUsada = false;
            for (var _kk in IDX) {
              if (IDX[_kk] === ci2) { yaUsada = true; break; }
            }
            if (yaUsada) continue;
            if (encN === aliasNom) continue;
            var match = (encN.indexOf(aliasNom) !== -1) || (aliasNom.indexOf(encN) !== -1);
            if (match) { IDX[aliasClv] = ci2; break; }
          }
        }
      } catch(_fuzzyErr2) {}
      // --- Paso 3 EXTRA para F1..F8/FM/F: REGEX directo en encabezados por etapa (anti fallo alias) ---
      const etapasRegex = [
        { clave: 'F1', re: /CONCEPTO.*ENVIAD|ENVIAD.*CONCEPTO/i },
        { clave: 'F2', re: /CONCEPTO.*APROBAD|APROBAD.*CONCEPTO/i },
        { clave: 'F3', re: /PRE.*PROD.*ENVIA|PREPROD.*ENVIA|ENVIA.*PREPROD/i },
        { clave: 'F4', re: /PRE.*PROD.*APROB|PREPROD.*APROB|APROB.*PREPROD/i },
        { clave: 'F5', re: /FOTOS.*PROD.*ENV|PROD.*ENV.*FOTOS|FOTOSDEPRODUCIONENVIADA|FOTOSDEPRODUCCIONENVIADA|FOTOSPROD.*ENVIAD|FOTODEPROD.*ENVIAD/i },
        { clave: 'F6', re: /FOTOS.*PROD.*APROB|PROD.*APROB.*FOTOS|FOTOSDEPRODUCIONAPROBADA|FOTOSDEPRODUCCIONAPROBADA|FOTOSPROD.*APROBAD|FOTODEPROD.*APROBAD/i },
        { clave: 'F7', re: /MUESTRA.*FINAL.*ENVIA|FINAL.*MUESTRA.*ENVIAD|APROBACIONFINALENVIAD/i },
        { clave: 'F8', re: /APROBADA.*CERRADA|CERRADA.*APROBADA|APROBACIONFINALAPROBAD/i },
        { clave: 'FM', re: /ENVIO.*MUESTR|MUESTRA.*ENVIO|FECHAMUESTRA/i }
      ];
      for (let ee=0; ee<etapasRegex.length; ee++) {
        const etapa = etapasRegex[ee];
        if (etapa.clave in IDX) continue; // ya detectada
        for (let ci3=0; ci3<aliasEncabezados.length; ci3++) {
          if (!aliasEncabezados[ci3]) continue;
          // evitar columna ya asignada
          var ocupada = false;
          for (var kkk in IDX) if (IDX[kkk] === ci3) { ocupada = true; break; }
          if (ocupada) continue;
          if (etapa.re.test(aliasEncabezados[ci3])) { IDX[etapa.clave] = ci3; break; }
        }
      }
      // --- Paso 4 EXTRA: BUSQUEDA EN HEADER ORIGINAL (no normalizado, tal cual tu Excel) indexOf case insensitive ---
      const buscarHeaderRawEtapas = [
        ['F1', ['Concepto Enviado', 'CONCEPTO ENVIADO']],
        ['F2', ['Concepto Aprobado', 'CONCEPTO APROBADO']],
        ['F3', ['Pre-Produccion Enviada', 'Pre Produccion Enviada', 'PREPRODUCCION ENVIADA']],
        ['F4', ['Pre-Produccion Aprobada', 'Pre Produccion Aprobada', 'PREPRODUCCION APROBADA']],
        ['F5', ['Fotos de produccion enviada', 'Fotos Produccion Enviada', 'FOTOS DE PRODUCCION ENVIADA', 'Fotos Enviadas Produccion']],
        ['F6', ['Fotos de producion aprobada', 'Fotos Produccion Aprobada', 'FOTOS DE PRODUCCION APROBADA', 'Fotos Aprobada Produccion']],
        ['F7', ['Muestras Finales Enviadas', 'MUESTRAS FINALES ENVIADAS']],
        ['F8', ['Aprobada / Cerrada', 'Aprobada/Cerrada', 'Aprobada y Cerrada', 'APROBADA CERRADA']],
        ['FM', ['Fecha Envio Muestras', 'Fecha de Envio de Muestras']]
      ];
      for (let bi=0; bi<buscarHeaderRawEtapas.length; bi++) {
        const etapa = buscarHeaderRawEtapas[bi];
        const clave = etapa[0];
        if (clave in IDX) continue;
        const textos = etapa[1] || [];
        for (let ti=0; ti<textos.length; ti++) {
          const txtBuscado = String(textos[ti]).toLowerCase();
          for (let cc=0; cc<header.length; cc++) {
            const valorHeader = String(header[cc] || '').toLowerCase();
            if (!valorHeader) continue;
            if (valorHeader.indexOf(txtBuscado) >= 0 || txtBuscado.indexOf(valorHeader) >= 0) {
              var ocup = false;
              for (var kk2 in IDX) if (IDX[kk2] === cc) { ocup = true; break; }
              if (!ocup) { IDX[clave] = cc; break; }
            }
          }
          if (clave in IDX) break;
        }
      }
      // --- Paso 5 EXTRA: PALABRAS CLAVE REQUERIDAS ---
      const requeridosEtapas = [
        ['F1', ['concep', 'envi']],
        ['F2', ['concep', 'apro']],
        ['F3', ['pre', 'prod', 'envi']],
        ['F4', ['pre', 'prod', 'apro']],
        ['F5', ['foto', 'prod', 'envi']],
        ['F6', ['foto', 'prod', 'apro']],
        ['F7', ['muestr', 'final', 'envi']],
        ['F8', ['aprob', 'cerr']],
        ['FM', ['envio', 'muestr']]
      ];
      for (let ri=0; ri<requeridosEtapas.length; ri++) {
        const etapa = requeridosEtapas[ri];
        const clave = etapa[0];
        if (clave in IDX) continue;
        const reqs = etapa[1] || [];
        for (let cc=0; cc<header.length; cc++) {
          const vh = String(header[cc] || '').toLowerCase();
          if (!vh) continue;
          var todos = true;
          for (let rr=0; rr<reqs.length; rr++) { if (vh.indexOf(reqs[rr]) < 0) { todos = false; break; } }
          if (!todos) continue;
          var ocup3 = false;
          for (var k3 in IDX) if (IDX[k3] === cc) { ocup3 = true; break; }
          if (!ocup3) { IDX[clave] = cc; break; }
        }
      }
      // Columnas OPA y Estado Plataforma SON REQUERIDAS MÍNIMAS (si no hay no podemos mostrar)
      if (typeof IDX['O'] === 'undefined') continue;

      const datosFilas = hoja.getRange(2, 1, lr-1, Math.min(lc, 80)).getDisplayValues() || [];

      for (let ir = 0; ir < datosFilas.length; ir++) {
        const fila = datosFilas[ir];
        const valorOPA = String(fila[IDX['O']] || '').trim();
        if (!valorOPA) continue;

        const hit = (valorOPA.toLowerCase().indexOf(query) >= 0);
        if (!hit) continue;

        const objResultado = {
          hoja: nombreHoja,
          fila: ir + 2,
          numeroOPA: valorOPA,
          estadoPlataforma: typeof IDX['E'] !== 'undefined' ? String(fila[IDX['E']] || '') : '',
          proyecto: typeof IDX['P'] !== 'undefined' ? String(fila[IDX['P']] || '') : '',
          tipoProducto: typeof IDX['T'] !== 'undefined' ? String(fila[IDX['T']] || '') : '',
          territorio: typeof IDX['TR'] !== 'undefined' ? String(fila[IDX['TR']] || '') : '',
          personaje: typeof IDX['PJ'] !== 'undefined' ? String(fila[IDX['PJ']] || '') : '',
          subOpa: typeof IDX['SO'] !== 'undefined' ? String(fila[IDX['SO']] || '') : '',
          linkFoto: typeof IDX['LF'] !== 'undefined' ? String(fila[IDX['LF']] || '') : '',
          headers: {
            F1: typeof IDX['F1'] !== 'undefined' ? String(header[IDX['F1']] || 'Concepto Enviado') : '',
            F2: typeof IDX['F2'] !== 'undefined' ? String(header[IDX['F2']] || 'Concepto Aprobado') : '',
            F3: typeof IDX['F3'] !== 'undefined' ? String(header[IDX['F3']] || 'Pre-Producción Enviada') : '',
            F4: typeof IDX['F4'] !== 'undefined' ? String(header[IDX['F4']] || 'Pre-Producción Aprobada') : '',
            F5: typeof IDX['F5'] !== 'undefined' ? String(header[IDX['F5']] || 'Fotos Producción Enviada') : '',
            F6: typeof IDX['F6'] !== 'undefined' ? String(header[IDX['F6']] || 'Fotos Producción Aprobada') : '',
            F7: typeof IDX['F7'] !== 'undefined' ? String(header[IDX['F7']] || 'Muestras Finales Enviadas') : '',
            F8: typeof IDX['F8'] !== 'undefined' ? String(header[IDX['F8']] || 'Aprobada / Cerrada') : '',
            FM: typeof IDX['FM'] !== 'undefined' ? String(header[IDX['FM']] || 'Fecha Envío Muestras') : '',
            F:  typeof IDX['F']  !== 'undefined' ? String(header[IDX['F']]  || 'Fecha') : ''
          },
          fechas: {
            F1: typeof IDX['F1'] !== 'undefined' ? String(fila[IDX['F1']] || '') : '',
            F2: typeof IDX['F2'] !== 'undefined' ? String(fila[IDX['F2']] || '') : '',
            F3: typeof IDX['F3'] !== 'undefined' ? String(fila[IDX['F3']] || '') : '',
            F4: typeof IDX['F4'] !== 'undefined' ? String(fila[IDX['F4']] || '') : '',
            F5: typeof IDX['F5'] !== 'undefined' ? String(fila[IDX['F5']] || '') : '',
            F6: typeof IDX['F6'] !== 'undefined' ? String(fila[IDX['F6']] || '') : '',
            F7: typeof IDX['F7'] !== 'undefined' ? String(fila[IDX['F7']] || '') : '',
            F8: typeof IDX['F8'] !== 'undefined' ? String(fila[IDX['F8']] || '') : '',
            FM: typeof IDX['FM'] !== 'undefined' ? String(fila[IDX['FM']] || '') : '',
            F:  typeof IDX['F']  !== 'undefined' ? String(fila[IDX['F']]  || '') : ''
          }
        };
        resultados.push(objResultado);
      }
    }
    return { ok: true, resultados: resultados, total: resultados.length };
  } catch(err) {
    return { ok: false, error: err.message || 'Error al buscar OPA.' };
  }
}
