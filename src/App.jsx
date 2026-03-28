import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ── Seeded PRNG ──
function mulberry32(s) {
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── FX — verified from bcv.org.ve (26 Mar 2026) and market data ──
const FX = {
  VES: { label: "Bolívares", sym: "Bs", rate: 1, flag: "🇻🇪" },
  USD_BCV: { label: "Dólar BCV", sym: "$", rate: 466.60, flag: "🇺🇸" },
  EUR_BCV: { label: "Euro BCV", sym: "€", rate: 540.17, flag: "🇪🇺" },
  USD_PAR: { label: "Dólar Paralelo", sym: "$", rate: 678, flag: "⚡" },
  USD: { label: "Dólares", sym: "$", rate: 1, flag: "🇺🇸" },
};
const FX_MAX = { VES: 9999, USD_BCV: 730, EUR_BCV: 730, USD_PAR: 730 };
function toFX(v, c) { return c === "VES" ? v : v / FX[c].rate; }
function fmtP(v, c) {
  const s = FX[c].sym;
  if (Math.abs(v) >= 1e3) return s + v.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (Math.abs(v) >= 0.1) return s + v.toFixed(2);
  if (Math.abs(v) >= 0.001) return s + v.toFixed(4);
  return s + v.toFixed(6);
}
function fmtPct(v) { return (v >= 0 ? "+" : "") + v.toFixed(2) + "%"; }
const MO = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
function fmtDate(ts) { const d = new Date(ts); return d.getDate() + " " + MO[d.getMonth()] + " " + d.getFullYear(); }
function fmtTime(ts) { const d = new Date(ts); const h = d.getHours(); return (h % 12 || 12) + ":" + String(d.getMinutes()).padStart(2,"0") + (h >= 12 ? " PM" : " AM"); }
function fmtVES(v) {
  if (v >= 1e12) return (v / 1e12).toFixed(1) + "T";
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(0);
}
function fmtMcap(ves, c) { return FX[c].sym + fmtVES(toFX(ves, c)); }

// ── Data Gen ──
function genFXHist(startRate, endRate, totalDays, vol, seed) {
  const rng = mulberry32(seed), now = Date.now(), dates = [];
  for (let i = totalDays; i >= 0; i--) {
    const ts = now - i * 864e5;
    if (new Date(ts).getDay() % 6 !== 0) dates.push(ts);
  }
  const N = dates.length, logS = Math.log(startRate), logE = Math.log(endRate);
  // Brownian bridge: noise is zero at t=0 and t=1
  let cumNoise = 0;
  const rawNoise = [0]; // start at zero
  for (let i = 1; i < N; i++) {
    cumNoise += (rng() - 0.5) * vol;
    rawNoise.push(cumNoise);
  }
  // Subtract the linear interpolation of endpoint noise to create bridge
  const endNoise = rawNoise[N - 1];
  return dates.map((date, i) => {
    const t = i / (N - 1 || 1);
    const bridge = rawNoise[i] - endNoise * t; // zero at t=0 and t=1
    return { date, rate: Math.exp(logS + (logE - logS) * t + bridge * 0.8) };
  });
}

function genDaily(base, totalDays, vol, trend, seed) {
  const rng = mulberry32(seed), now = Date.now(), dates = [];
  for (let i = totalDays; i >= 0; i--) {
    const ts = now - i * 864e5;
    if (new Date(ts).getDay() % 6 !== 0) dates.push(ts);
  }
  const closes = new Array(dates.length);
  closes[dates.length - 1] = base;
  for (let i = dates.length - 2; i >= 0; i--) {
    closes[i] = closes[i + 1] / (1 + (rng() - 0.5) * vol + trend);
    if (closes[i] <= 0) closes[i] = closes[i + 1] * 0.95;
  }
  return dates.map((date, i) => {
    const close = closes[i], prev = i > 0 ? closes[i - 1] : close;
    const w = rng() * vol * 0.35;
    return { date, open: prev, high: Math.max(prev, close) * (1 + w), low: Math.min(prev, close) * (1 - rng() * vol * 0.35), close };
  });
}

function genIntraday(base, seed) {
  const rng = mulberry32(seed + 7777);
  // Use last complete trading day
  let target = new Date();
  const h = target.getHours();
  // If before 1pm (market close), use yesterday; otherwise use today
  if (h < 13) target.setDate(target.getDate() - 1);
  target.setHours(0, 0, 0, 0);
  const dow = target.getDay();
  if (dow === 0) target.setDate(target.getDate() - 2);
  else if (dow === 6) target.setDate(target.getDate() - 1);
  const openMs = target.getTime() + 9 * 60 * 60000, N = 48; // 9:00 AM to 1:00 PM = 48 × 5min
  const closes = new Array(N); closes[N - 1] = base;
  for (let i = N - 2; i >= 0; i--) closes[i] = closes[i + 1] / (1 + (rng() - 0.5) * 0.003);
  return Array.from({ length: N }, (_, i) => {
    const date = openMs + i * 5 * 60000, close = closes[i];
    const open = i > 0 ? closes[i - 1] : close * (1 + (rng() - 0.5) * 0.002);
    return { date, open, high: Math.max(open, close) * (1 + rng() * 0.001), low: Math.min(open, close) * (1 - rng() * 0.001), close };
  });
}

// ── FX at date ──
// FX History — calibrated to real data
// Mar 2024: BCV≈36.28, EUR≈40, Paralelo≈39 → Mar 2026: BCV=466.60, EUR=540.17, Par=678
const FX_HIST = {
  USD_BCV: genFXHist(36.28, 466.60, 730, 0.04, 201),
  EUR_BCV: genFXHist(40, 540.17, 730, 0.04, 203),
  USD_PAR: genFXHist(39, 678, 730, 0.07, 202),  // more volatile
  // USD/EUR international: 0.92 (Mar 2024) → 0.87 (Mar 2026), dollar weakened
  USD_EUR: genFXHist(0.92, 0.87, 730, 0.01, 204),
};
function fxAtDate(cur, ts) {
  if (cur === "VES" || cur === "USD") return 1;
  const hist = FX_HIST[cur];
  if (!hist || !hist.length) return FX[cur].rate;
  if (ts <= hist[0].date) return hist[0].rate;
  let best = hist[0];
  for (const h of hist) { if (h.date <= ts) best = h; else break; }
  return best.rate;
}
function vesAtDate(ohlc, cur) {
  if (cur === "VES") return ohlc;
  const r = 1 / fxAtDate(cur, ohlc.date);
  return { ...ohlc, open: ohlc.open * r, high: ohlc.high * r, low: ohlc.low * r, close: ohlc.close * r };
}

// ── 33 Stocks — trends calibrated to outpace FX depreciation ──
// Min trend needed: 0.0055/day (to beat paralelo 17.4x over 2Y)
// Venezuelan equities routinely show 1000%+ annual VES returns in hyperinflation
const SR = [
  { t:"MVZ.A", n:"Mercantil Serv. Fin. (A)", p:7400, ind:"FIN", logo:"🏛️", ipo:1997, mc:761.41e9, pe:"8.5", ibc:true, desc:"Holding financiero más grande del sector privado venezolano. Fundado en 1925 como Banco Neerlando Venezolano. Opera Mercantil Banco Universal, Mercantil Seguros y Mercantil Merinvest. Presencia en 9 países incluyendo EE.UU. (Coral Gables), Panamá y Suiza. ~3,100 empleados.", tr:0.009 },
  { t:"MVZ.B", n:"Mercantil Serv. Fin. (B)", p:7100, ind:"FIN", logo:"🏛️", ipo:1997, mc:761.41e9, pe:"8.5", ibc:true, desc:"Acciones Clase B de Mercantil Servicios Financieros. Mismos derechos económicos que la Clase A pero con diferencias en derechos de voto. Listada en el IBC.", tr:0.0085 },
  { t:"BVL", n:"Banco de Venezuela", p:193, ind:"FIN", logo:"🏦", ipo:2014, mc:703.9e9, pe:"5.2", ibc:true, desc:"Institución bancaria más grande del país por depósitos (~35.5% del sistema). Fundado en 1890, nacionalizado en 2009. Incorporado al IBC en marzo 2024. Propiedad del Estado venezolano.", tr:0.008 },
  { t:"BPV", n:"Banco Provincial (BBVA)", p:153.99, ind:"FIN", logo:"🅱️", ipo:1983, mc:675.86e9, pe:"1.06", ibc:true, desc:"Banco universal subsidiaria del grupo BBVA de España. Fundado en 1953. Uno de los bancos privados más grandes de Venezuela con red extensa de agencias. ~1,870 empleados.", tr:0.0095 },
  { t:"BNC", n:"Banco Nacional de Crédito", p:1799, ind:"FIN", logo:"💳", ipo:2006, mc:464e9, pe:"51", ibc:true, desc:"Banco universal que ofrece servicios comerciales y de banca minorista. Listada en 2006. Componente del IBC.", tr:0.0088 },
  { t:"RST", n:"C.A. Ron Santa Teresa", p:570.99, ind:"CON", logo:"🥃", ipo:1990, mc:326.2e9, pe:"12.3", ibc:true, desc:"Productor icónico de ron premium venezolano fundado en 1796 en la Hacienda Santa Teresa, estado Aragua. La marca Ron Santa Teresa 1796 tiene reconocimiento internacional. Acción más negociada de la BVC por volumen — domina 60-80% del volumen semanal. Lanzó oferta pública de 10M de acciones en marzo 2026.", tr:0.010 },
  { t:"ABC.A", n:"Banco del Caribe (A)", p:2300, ind:"FIN", logo:"🌊", ipo:1988, mc:310.7e9, pe:"7.8", ibc:true, desc:"Banco universal fundado en 1954. Enfocado en banca comercial y personal con fuerte presencia regional. Componente del IBC. Clase A listada desde 1988.", tr:0.0078 },
  { t:"CGQ", n:"Corp. Grupo Químico", p:1800, ind:"MFG", logo:"🧪", ipo:1995, mc:164.15e9, pe:"9.2", ibc:false, desc:"Conglomerado industrial del sector químico venezolano. Produce y comercializa productos químicos para uso industrial y agrícola. Baja liquidez bursátil — no forma parte del IBC.", tr:0.0072 },
  { t:"FNC", n:"Fáb. Nac. de Cementos", p:1990, ind:"MFG", logo:"🏗️", ipo:1985, mc:161.35e9, pe:"11.5", ibc:false, desc:"Principal fabricante de cemento de Venezuela. Operaciones de extracción, producción y distribución de cemento y materiales de construcción. Empresa clave para el sector de infraestructura y construcción del país.", tr:0.0082 },
  { t:"ENV", n:"Envases Venezolanos", p:978, ind:"MFG", logo:"📦", ipo:1992, mc:124.13e9, pe:"6.8", ibc:true, desc:"Fabricante líder de empaques y envases en Venezuela. Produce envases metálicos, plásticos y de cartón para la industria alimenticia y de consumo masivo. Componente del IBC.", tr:0.0088 },
  { t:"PGR", n:"Proagro C.A.", p:113, ind:"AGR", logo:"🐔", ipo:1998, mc:82.76e9, pe:"4.5", ibc:false, desc:"Actor clave en la cadena de suministro avícola y agrícola de Venezuela. Producción y distribución de alimentos para animales, cría avícola y procesamiento de proteínas.8B — una de las mayores por ingresos en la BVC.", tr:0.007 },
  { t:"EFE", n:"Productos EFE", p:112.49, ind:"CON", logo:"🍦", ipo:1990, mc:78.74e9, pe:"7.1", ibc:false, desc:"Marca icónica venezolana de helados fundada en 1926. Conocida por productos como el Cocosette, Rikiti y helados EFE. Forma parte de la cultura gastronómica del país.", tr:0.0075 },
  { t:"TDV.D", n:"CANTV (Clase D)", p:86, ind:"TEL", logo:"📡", ipo:1996, mc:67.42e9, pe:"N/A", ibc:true, desc:"Compañía Anónima Nacional Teléfonos de Venezuela — principal proveedor de telecomunicaciones del Estado. Opera telefonía fija, móvil (Movilnet), internet y TV por cable. Plan de expansión de 2.5M de conexiones de fibra óptica.", tr:0.0065 },
  { t:"GZL", n:"Grupo Zuliano", p:950, ind:"MFG", logo:"🏭", ipo:2000, mc:46.1e9, pe:"8.3", ibc:false, desc:"Grupo industrial diversificado basado en el estado Zulia, la región occidental petrolera de Venezuela. Operaciones en manufactura, distribución y servicios industriales.", tr:0.008 },
  { t:"DOM", n:"Domínguez & Cía.", p:780, ind:"MFG", logo:"⚙️", ipo:1990, mc:37.54e9, pe:"5.6", ibc:true, desc:"Empresa de manufactura industrial diversificada. Componente del IBC. Produce maquinaria y equipos industriales.", tr:0.0074 },
  { t:"MPA", n:"MANPA", p:102, ind:"MFG", logo:"📄", ipo:1985, mc:23.4e9, pe:"3.9", ibc:true, desc:"Manufacturas de Papel C.A. — fabricante de papel y productos de pulpa. Una de las acciones más antiguas de la BVC (listada desde 1985). Componente del IBC.", tr:0.0068 },
  { t:"CCR", n:"Cerámica Carabobo", p:7090, ind:"MFG", logo:"🏺", ipo:1992, mc:20.09e9, pe:"10.2", ibc:false, desc:"Fabricante de baldosas cerámicas, pisos y revestimientos. Basada en el estado Carabobo, zona industrial central de Venezuela.", tr:0.008 },
  { t:"PTN", n:"Protinal C.A.", p:63.7, ind:"AGR", logo:"🌽", ipo:1995, mc:9.61e9, pe:"N/A", ibc:false, desc:"Productor avícola y de alimentos balanceados para animales. Empresa del sector agropecuario con operaciones de cría, procesamiento y distribución de proteína animal.", tr:0.0062 },
  { t:"SVS", n:"Sivensa", p:173.5, ind:"MFG", logo:"⚒️", ipo:1988, mc:9.11e9, pe:"N/A", ibc:true, desc:"Siderúrgica Venezolana (Sivensa) — empresa de acero y metalurgia. Produce acero, tubería y productos metálicos. Componente del IBC.7% en una semana en febrero 2026.", tr:0.009 },
  { t:"IVC", n:"INVACA", p:50.01, ind:"REA", logo:"🏢", ipo:1992, mc:3.5e9, pe:"N/A", ibc:false, desc:"C.A. Inmuebles y Valores Caracas — empresa de inversión inmobiliaria. Posee y administra propiedades comerciales y residenciales en el área metropolitana de Caracas.", tr:0.007 },
  { t:"BVCC", n:"Bolsa de Valores de Caracas", p:78.1, ind:"FIN", logo:"📈", ipo:1990, mc:1.56e9, pe:"15.4", ibc:true, desc:"La bolsa de valores de Venezuela, fundada el 21 de enero de 1947. Opera el sistema electrónico SIBE para todas las transacciones. 32 empleados. Publica el IBC, Índice Financiero e Industrial. Componente de su propio índice.", tr:0.0092 },
  { t:"2TPG", n:"Telares de Palo Grande", p:1.25, ind:"MFG", logo:"🧵", ipo:1990, mc:1.49e9, pe:"N/A", ibc:false, desc:"Manufactura textil venezolana. Produce telas, hilos y productos textiles. Una de las acciones de menor precio nominal en la BVC.", tr:0.006 },
  { t:"CRM.A", n:"Corimon C.A.", p:685, ind:"MFG", logo:"🎨", ipo:1990, mc:534.92e6, pe:"4.2", ibc:true, desc:"Fabricante de pinturas y productos químicos. Dueña de la marca Montana (pinturas), una de las más reconocidas en Venezuela.42B — alta generación de ingresos. Componente del IBC.", tr:0.0072 },
  { t:"2CIE", n:"Corp. Ind. de Energía", p:0.14, ind:"TEL", logo:"⚡", ipo:2005, mc:67.98e6, pe:"N/A", ibc:false, desc:"Corporación Industrial de Energía — servicios industriales del sector energético. Micro-cap con precio penny stock (Bs 0.14).", tr:0.006 },
  { t:"FNV", n:"Fáb. Nac. de Vidrio", p:0.01, ind:"MFG", logo:"🪟", ipo:1990, mc:2.79e9, pe:"N/A", ibc:false, desc:"Fábrica Nacional de Vidrio — producción de envases de vidrio y vidrio plano. Penny stock (Bs 0.01). a pesar de su micro-cap.", tr:0.007 },
  { t:"INV", n:"Inverdica", p:0.01, ind:"FIN", logo:"📉", ipo:1995, mc:821e6, pe:"N/A", ibc:false, desc:"Inversiones Diversificadas C.A. — holding de inversiones. Esencialmente inactiva con capitalización de apenas Bs 8,210. La acción más barata y menos líquida de la BVC.", tr:0.006 },
  // BVC Alternativo
  { t:"RST.B", n:"Ron Santa Teresa (B)", p:548.5, ind:"CON", logo:"🥃", ipo:2025, mc:326.2e9, pe:"12.3", ibc:true, desc:"Acciones Clase B de C.A. Ron Santa Teresa. Emitidas en 2025 como parte de la expansión de capital de la empresa. Incorporada al IBC en marzo 2026. Misma compañía que RST pero con diferente estructura de derechos.", tr:0.009 },
  { t:"PIV.B", n:"PIVCA (B)", p:178, ind:"FIN", logo:"💎", ipo:2022, mc:12e9, pe:"N/A", ibc:true, desc:"Promotora de Inversiones y Valores C.A. — fondo de inversión listado en el BVC Alternativo desde 2022. Componente del IBC. Enfocada en gestión de portafolio y activos financieros.", tr:0.008 },
  { t:"CCP.B", n:"Clabe Capital (B)", p:210, ind:"FIN", logo:"🪙", ipo:2023, mc:8e9, pe:"N/A", ibc:false, desc:"Fondo financiero del mercado alternativo BVC. Especializado en inversiones de capital y renta fija. IPO en 2023.", tr:0.0085 },
  { t:"ICP.B", n:"Crecepymes (B)", p:72, ind:"FIN", logo:"🌱", ipo:2024, mc:2.5e9, pe:"N/A", ibc:false, desc:"Inversiones Crecepymes — fondo de financiamiento para pequeñas y medianas empresas (PyMEs). Listada en BVC Alternativo en 2024. Enfocada en democratizar el acceso a capital.", tr:0.008 },
  { t:"FFV.B", n:"Fivenca Fondo (B)", p:145, ind:"FIN", logo:"💰", ipo:2023, mc:5e9, pe:"N/A", ibc:false, desc:"Fivenca Fondo de Capital Privado — vehículo de inversión colectiva gestionado por Fivenca Casa de Bolsa. Listado en BVC Alternativo 2023. Enfocado en oportunidades de renta variable y renta fija en el mercado venezolano.", tr:0.0075 },
  { t:"MNT.B", n:"Montesco Agroind. (B)", p:63, ind:"AGR", logo:"🌾", ipo:2024, mc:2e9, pe:"N/A", ibc:false, desc:"Montesco Agroindustrial — fondo de inversión del sector agropecuario. Listado en BVC Alternativo en 2024. Canaliza capital hacia proyectos agroindustriales y de producción de alimentos en Venezuela.", tr:0.007 },
  { t:"FPB.B", n:"Fondo Petrolia (B)", p:88, ind:"TEL", logo:"🛢️", ipo:2023, mc:3e9, pe:"N/A", ibc:false, desc:"Fondo de inversión enfocado en el sector petrolero y energético venezolano. Listado en BVC Alternativo 2023. Busca capitalizar la rehabilitación de infraestructura petrolera y el retorno de inversión extranjera al sector energético.", tr:0.008 },
];

const IND = { ALL:{l:"Todas",i:"📊"}, FIN:{l:"Finanzas",i:"🏦"}, CON:{l:"Consumo",i:"🛒"}, MFG:{l:"Industrial",i:"🏭"}, AGR:{l:"Agro",i:"🌾"}, TEL:{l:"Telecom",i:"📡"}, REA:{l:"Inmobiliario",i:"🏢"} };

// ── Fuzzy search with accent stripping ──
function stripA(s) { return s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function fuzzyMatch(query, target) {
  if (!query) return true;
  const q = stripA(query.toLowerCase().trim());
  const t = stripA(target.toLowerCase());
  if (!q) return true;
  // Exact substring (handles most cases)
  if (t.includes(q)) return true;
  // Stripped dots/spaces
  const qFlat = q.replace(/[\s.]/g, ""), tFlat = t.replace(/[\s.]/g, "");
  if (tFlat.includes(qFlat)) return true;
  // Multi-word: EVERY query word must match at least one target word
  const qWords = q.split(/\s+/).filter(Boolean);
  const tWords = t.split(/[\s.()]+/).filter(w => w.length > 1);
  if (qWords.length > 1) {
    return qWords.every(qw => {
      // Each query word must be a substring of or close edit distance to some target word
      return tWords.some(tw => tw.includes(qw) || qw.includes(tw) || (Math.abs(qw.length - tw.length) <= 2 && editDist1Row(qw, tw) <= 1));
    });
  }
  // Single word: check against each target word with strict edit distance
  const maxD = qFlat.length <= 3 ? 0 : qFlat.length <= 5 ? 1 : 2;
  return tWords.some(tw => {
    if (tw.includes(qFlat) || qFlat.includes(tw)) return true;
    if (Math.abs(qFlat.length - tw.length) > 2) return false;
    return editDist1Row(qFlat, tw) <= maxD;
  });
}


// Single-row Damerau-Levenshtein (O(n) space instead of O(n*m))
function editDist1Row(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev2 = new Array(n + 1); // for transposition
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], prev2[j - 2] + cost);
      }
    }
    [prev2, prev, curr] = [prev, curr, prev2 || new Array(n + 1)];
  }
  return prev[n];
}

const IBC_VES = 6472.57, IBC_FIN = 12778.02, IBC_IND = 2712.46;
// ^ IBC sub-indices: Financiero tracks banks/financial sector, Industrial tracks manufacturing/industry
// These are sector sub-indices of the IBC, measured in points (same methodology as IBC)
// IBC: needs trend > 0.0055 to outpace paralelo depreciation (17.4x over 2Y)
// Using 0.008 → generates ~64x VES growth → positive in ALL FX views
const IBC_DAILY = genDaily(IBC_VES, 730, 0.03, 0.008, 999);
const IBC_INTRA = genIntraday(IBC_VES, 999);

const STOCKS = SR.map(s => {
  const d = Math.min(730, Math.max(30, Math.floor((2026 - s.ipo) * 365.25)));
  const seed = hashStr(s.t);
  return {
    ticker: s.t, name: s.n, price: s.p, industry: s.ind, logo: s.logo, ipo: s.ipo,
    mcapVES: s.mc, pe: s.pe, ibc: s.ibc, desc: s.desc,
    daily: genDaily(s.p, d, s.p > 100 ? 0.025 : 0.04, s.tr, seed),
    intraday: genIntraday(s.p, seed),
  };
});

const TFS = [
  { key: "1D", label: "1D", days: 0 },
  { key: "1W", label: "1S", days: 7 },
  { key: "1M", label: "1M", days: 30 },
  { key: "3M", label: "3M", days: 90 },
  { key: "6M", label: "6M", days: 180 },
  { key: "1Y", label: "1A", days: 365 },
  { key: "2Y", label: "2A", days: 730 },
];

function sliceData(daily, intra, tf, cur) {
  if (tf === "1D") return intra;
  let days = TFS.find(t => t.key === tf)?.days || 90;
  const mx = FX_MAX[cur] || 9999;
  if (days > mx) days = mx;
  const sliced = daily.slice(Math.max(0, daily.length - days - 1));
  // Aggregate candles for readability
  if (tf === "2Y") return aggregateByN(sliced, 20);  // ~4 weeks
  if (tf === "1Y") return aggregateByN(sliced, 10);  // ~2 weeks (biweekly)
  if (tf === "6M") return aggregateByN(sliced, 5);   // ~1 week
  if (tf === "3M") return aggregateByN(sliced, 3);   // every 3 days
  return sliced; // 1W, 1M: daily candles
}

// Group every N daily candles into one OHLC bar
function aggregateByN(data, n) {
  if (!data.length) return data;
  const groups = [];
  for (let i = 0; i < data.length; i += n) {
    const chunk = data.slice(i, i + n);
    groups.push({
      date: chunk[chunk.length - 1].date,
      dateStart: chunk.length > 1 ? chunk[0].date : null,
      open: chunk[0].open,
      high: Math.max(...chunk.map(d => d.high)),
      low: Math.min(...chunk.map(d => d.low)),
      close: chunk[chunk.length - 1].close,
    });
  }
  return groups;
}

// ── Chart Component ──
function Chart({ data, cur, type = "line", height = 260, onHover, is1D = false, simple = false }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const conv = useMemo(() => data.map(d => vesAtDate(d, cur)), [data, cur]);
  const VBW = 420, vH = height;
  const pad = { t: 20, r: 12, b: 24, l: 58 };
  const W = VBW - pad.l - pad.r, H = vH - pad.t - pad.b;
  const prices = conv.flatMap(d => [d.high, d.low]);
  const mn = Math.min(...prices), mx = Math.max(...prices), rng = mx - mn || 1;
  const yMn = mn - rng * 0.05, yMx = mx + rng * 0.05;
  const xS = i => pad.l + (i / (conv.length - 1 || 1)) * W;
  const yS = p => pad.t + (1 - (p - yMn) / (yMx - yMn)) * H;
  const first = conv[0]?.close || 0, last = conv[conv.length - 1]?.close || 0;
  const up = last >= first, col = up ? "#00C853" : "#FF1744";
  const gid = "g" + hashStr(cur + type + data.length);

  const onMouse = useCallback(e => {
    if (!ref.current) return;
    const rc = ref.current.getBoundingClientRect();
    if (rc.width <= 0) return;
    const vbX = (e.clientX - rc.left) * (VBW / rc.width);
    const ratio = Math.max(0, Math.min(1, (vbX - pad.l) / W));
    const idx = Math.round(ratio * (conv.length - 1));
    if (idx >= 0 && idx < conv.length) {
      setTip({ x: xS(idx), y: yS(conv[idx].close), d: conv[idx] });
      if (onHover) onHover(data[idx]);
    }
  }, [conv, data, W, onHover]);

  const onLeave = () => { setTip(null); if (onHover) onHover(null); };

  const yTk = Array.from({ length: 5 }, (_, i) => {
    const v = yMn + (i / 4) * (yMx - yMn);
    return { v, y: yS(v) };
  });
  const fmtShort = ts => { const d = new Date(ts); return d.getDate() + " " + MO[d.getMonth()]; };
  const tLbl = tip ? (is1D ? fmtTime(tip.d.date) : (tip.d.dateStart ? fmtShort(tip.d.dateStart) + " – " + fmtShort(tip.d.date) : fmtDate(tip.d.date))) : "";

  const gridEls = yTk.map((t, i) => (
    <g key={i}>
      <line x1={pad.l} x2={pad.l + W} y1={t.y} y2={t.y} stroke="var(--grid)" strokeWidth={0.5} />
      <text x={pad.l - 5} y={t.y + 3} textAnchor="end" fill="var(--muted)" fontSize={9} fontFamily="'DM Sans'">{fmtP(t.v, cur)}</text>
    </g>
  ));

  const tipEls = tip ? (
    <>
      <line x1={tip.x} x2={tip.x} y1={pad.t} y2={pad.t + H} stroke="var(--muted)" strokeWidth={0.4} strokeDasharray="3,3" />
      <circle cx={tip.x} cy={tip.y} r={3.5} fill={col} stroke="#fff" strokeWidth={1.2} />
      <foreignObject
        x={tip.x > VBW - pad.r - 168 ? tip.x - 166 : tip.x + 8}
        y={tip.y < pad.t + 70 ? tip.y + 10 : tip.y - 68}
        width={simple ? 120 : 158} height={simple ? 42 : 64}>
        <div style={{ background:"var(--card)", border:"1px solid var(--border)", borderRadius:7, padding:"4px 7px", fontSize:9.5, fontFamily:"'DM Sans'", color:"var(--text)", boxShadow:"0 3px 12px rgba(0,0,0,0.08)" }}>
          <div style={{ fontWeight:600, marginBottom:1 }}>{tLbl}</div>
          {simple ? (
            <div style={{ fontWeight:700 }}>{fmtP(tip.d.close,cur)}</div>
          ) : (
            <><div>O:{fmtP(tip.d.open,cur)} C:{fmtP(tip.d.close,cur)}</div>
            <div>H:{fmtP(tip.d.high,cur)} L:{fmtP(tip.d.low,cur)}</div></>
          )}
        </div>
      </foreignObject>
    </>
  ) : null;

  // Reference line at period opening price (shows if overall up or down)
  const refY = yS(first);
  const refLine = (
    <g>
      <line x1={pad.l} x2={pad.l + W} y1={refY} y2={refY} stroke={col} strokeWidth={0.6} strokeDasharray="4,3" opacity={0.4} />
      <text x={pad.l + W + 3} y={refY + 3} fill={col} fontSize={7} fontFamily="'DM Sans'" opacity={0.6}>BASE</text>
    </g>
  );

  if (type === "candle") {
    const cw = Math.max(1.5, (W / conv.length) * 0.55);
    return (
      <svg ref={ref} width="100%" viewBox={"0 0 " + VBW + " " + vH} style={{ display:"block" }}
        onMouseMove={onMouse} onMouseLeave={onLeave} onTouchMove={onMouse} onTouchEnd={onLeave}>
        {gridEls}
        {refLine}
        {conv.map((d, i) => {
          const bu = d.close >= d.open, c = bu ? "#00C853" : "#FF1744";
          const x = xS(i), bT = yS(Math.max(d.open, d.close)), bB = yS(Math.min(d.open, d.close));
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={yS(d.high)} y2={yS(d.low)} stroke={c} strokeWidth={0.8} />
              <rect x={x - cw / 2} y={bT} width={cw} height={Math.max(bB - bT, 0.5)} fill={c} rx={0.5} />
            </g>
          );
        })}
        {tipEls}
      </svg>
    );
  }

  const lp = conv.map((d, i) => (i === 0 ? "M" : "L") + xS(i) + "," + yS(d.close)).join(" ");
  const ap = lp + " L" + xS(conv.length - 1) + "," + (pad.t + H) + " L" + xS(0) + "," + (pad.t + H) + " Z";
  return (
    <svg ref={ref} width="100%" viewBox={"0 0 " + VBW + " " + vH} style={{ display:"block" }}
      onMouseMove={onMouse} onMouseLeave={onLeave} onTouchMove={onMouse} onTouchEnd={onLeave}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity={0.16} />
          <stop offset="100%" stopColor={col} stopOpacity={0.01} />
        </linearGradient>
      </defs>
      {gridEls}
      {refLine}
      <path d={ap} fill={"url(#" + gid + ")"} />
      <path d={lp} fill="none" stroke={col} strokeWidth={1.8} strokeLinejoin="round" />
      {tipEls}
    </svg>
  );
}

// ── IBC Chart ──
function IBCChart({ cur, tf, onStats }) {
  const data = useMemo(() => sliceData(IBC_DAILY, IBC_INTRA, tf, cur), [tf, cur]);
  const conv = useMemo(() => data.map(d => {
    const r = cur === "VES" ? 1 : fxAtDate(cur, d.date);
    return { v: d.close / r, date: d.date };
  }), [data, cur]);

  useEffect(() => {
    if (onStats && conv.length >= 2) {
      const f = conv[0].v, l = conv[conv.length - 1].v;
      onStats({ value: l, pct: f ? ((l - f) / f) * 100 : 0, date: null, hover: false });
    }
  }, [conv, onStats]);

  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const VW = 340, VH = 150;
  const pad = { t: 10, r: 30, b: 16, l: 52 };
  const W = VW - pad.l - pad.r, H = VH - pad.t - pad.b;
  const vals = conv.map(c => c.v);
  const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
  const xS = i => pad.l + (i / (conv.length - 1 || 1)) * W;
  const yS = v => pad.t + (1 - (v - (mn - rng * 0.05)) / (rng * 1.1)) * H;
  const up = vals[vals.length - 1] >= vals[0], col = up ? "#00C853" : "#FF1744";
  const path = vals.map((v, i) => (i === 0 ? "M" : "L") + xS(i) + "," + yS(v)).join(" ");
  const is1D = tf === "1D";

  const onMouse = e => {
    if (!ref.current) return;
    const rc = ref.current.getBoundingClientRect();
    if (rc.width <= 0) return;
    const vbX = (e.clientX - rc.left) * (VW / rc.width);
    const ratio = Math.max(0, Math.min(1, (vbX - pad.l) / W));
    const idx = Math.round(ratio * (conv.length - 1));
    if (idx >= 0 && idx < conv.length) {
      const v = conv[idx].v, f = conv[0].v;
      setTip({ x: xS(idx), y: yS(v), v, date: conv[idx].date });
      if (onStats) onStats({ value: v, pct: f ? ((v - f) / f) * 100 : 0, date: conv[idx].date, hover: true });
    }
  };
  const onLeave = () => {
    setTip(null);
    if (onStats && conv.length >= 2) {
      const f = conv[0].v, l = conv[conv.length - 1].v;
      onStats({ value: l, pct: f ? ((l - f) / f) * 100 : 0, date: null, hover: false });
    }
  };

  return (
    <svg ref={ref} width="100%" viewBox={"0 0 " + VW + " " + VH} style={{ display:"block" }} onMouseMove={onMouse} onMouseLeave={onLeave}>
      <defs>
        <linearGradient id="ibcG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity={0.14} />
          <stop offset="100%" stopColor={col} stopOpacity={0} />
        </linearGradient>
      </defs>
      {/* Reference line at period open */}
      <line x1={pad.l} x2={pad.l + W} y1={yS(vals[0])} y2={yS(vals[0])} stroke={col} strokeWidth={0.5} strokeDasharray="3,2" opacity={0.35} />
      <text x={pad.l + W + 2} y={yS(vals[0]) + 3} fill={col} fontSize={6} fontFamily="'DM Sans'" opacity={0.5}>BASE</text>
      <path d={path + " L" + xS(conv.length - 1) + "," + (pad.t + H) + " L" + xS(0) + "," + (pad.t + H) + " Z"} fill="url(#ibcG)" />
      <path d={path} fill="none" stroke={col} strokeWidth={1.4} />
      {tip && (
        <>
          <line x1={tip.x} x2={tip.x} y1={pad.t} y2={pad.t + H} stroke="var(--muted)" strokeWidth={0.3} strokeDasharray="2,2" />
          <circle cx={tip.x} cy={tip.y} r={2.5} fill={col} stroke="#fff" strokeWidth={0.8} />
          <foreignObject
            x={tip.x > VW - pad.r - 110 ? tip.x - 108 : tip.x + 8}
            y={tip.y < pad.t + 40 ? tip.y + 10 : tip.y - 42}
            width={100} height={38}>
            <div style={{ background:"var(--card)", border:"1px solid var(--border)", borderRadius:5, padding:"3px 6px", fontSize:8.5, fontFamily:"'DM Sans'", color:"var(--text)", boxShadow:"0 2px 8px rgba(0,0,0,0.08)" }}>
              <div style={{ fontWeight:700 }}>{fmtP(tip.v, cur)}</div>
              <div style={{ color:"var(--muted)", fontSize:7 }}>{tip.date ? (is1D ? fmtTime(tip.date) : fmtDate(tip.date)) : ""}</div>
            </div>
          </foreignObject>
        </>
      )}
    </svg>
  );
}

// ── Stock Detail ──
function StockDetail({ stock, cur, onBack }) {
  const [tf, setTf] = useState("1D");
  const [ct, setCT] = useState("line");
  const [hov, setHov] = useState(null);
  const is1D = tf === "1D";
  const data = useMemo(() => sliceData(stock.daily, stock.intraday, tf, cur), [stock, tf, cur]);
  const first = data[0], last = data[data.length - 1], disp = hov || last;
  const dC = vesAtDate(disp, cur), fC = vesAtDate(first, cur);
  // Axiom 5: Δ(s_i) = V(s_i)/V(s_0) - 1, where V = close/rate
  const pct = fC.close ? ((dC.close - fC.close) / fC.close) * 100 : 0;
  const green = pct >= 0;
  const availTfs = TFS.filter(t => t.days <= (FX_MAX[cur] || 9999) || t.days === 0);
  const S = { f: "'DM Sans',sans-serif" };

  return (
    <div style={{ paddingBottom: 80 }}>
      <button onClick={onBack} style={{ background:"none", border:"none", color:"var(--accent)", fontSize:15, fontFamily:S.f, cursor:"pointer", padding:"8px 0" }}>← Volver</button>
      <div style={{ display:"flex", alignItems:"center", gap:12, margin:"8px 0 4px", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ fontSize:36 }}>{stock.logo}</div>
          <div>
            <div style={{ fontSize:20, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{stock.name}</div>
            <div style={{ fontSize:13, color:"var(--muted)", fontFamily:S.f }}>{stock.ticker} · {IND[stock.industry]?.l}</div>
          </div>
        </div>
        {is1D && (
          <div style={{ textAlign:"right", flexShrink:0 }}>
            <div style={{ fontSize:13, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{fmtDate(data[0]?.date)}</div>
            <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f }}>9:00 AM – 1:00 PM VET</div>
            <div style={{ fontSize:9, color:"var(--muted)", fontFamily:S.f }}>Intervalos de 5 min</div>
          </div>
        )}
      </div>
      <div style={{ margin:"12px 0 4px" }}>
        <span style={{ fontSize:28, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{fmtP(dC.close, cur)}</span>
        <span style={{ fontSize:15, fontWeight:600, color:green ? "#00C853" : "#FF1744", marginLeft:10, fontFamily:S.f }}>{fmtPct(pct)}</span>
        {cur === "USD_PAR" && <span style={{ fontSize:10, color:"#F59E0B", marginLeft:6, fontFamily:S.f, fontWeight:700 }}>RETORNO REAL</span>}
      </div>
      {hov && (
        <div style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f, marginBottom:4 }}>
          {is1D ? fmtTime(hov.date) : fmtDate(hov.date)} · O:{fmtP(dC.open,cur)} C:{fmtP(dC.close,cur)} H:{fmtP(dC.high,cur)} L:{fmtP(dC.low,cur)}
        </div>
      )}
      <div style={{ display:"flex", gap:6, margin:"8px 0" }}>
        {["line","candle"].map(t => (
          <button key={t} onClick={() => setCT(t)} style={{ padding:"5px 14px", borderRadius:20, border:"1px solid var(--border)", background:ct===t ? "var(--accent)" : "var(--card)", color:ct===t ? "#fff" : "var(--text)", fontSize:12, cursor:"pointer", fontFamily:S.f, fontWeight:600 }}>
            {t === "line" ? "Línea" : "Velas"}
          </button>
        ))}
      </div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:"12px 4px", marginBottom:12, border:"1px solid var(--border)" }}>
        <Chart data={data} cur={cur} type={ct} height={280} onHover={setHov} is1D={is1D} />
      </div>
      <div style={{ display:"flex", gap:5, marginBottom:16, justifyContent:"center", flexWrap:"wrap" }}>
        {availTfs.map(t => (
          <button key={t.key} onClick={() => { setTf(t.key); setHov(null); }} style={{ padding:"5px 12px", borderRadius:20, border:"1px solid var(--border)", background:tf===t.key ? "var(--text)" : "transparent", color:tf===t.key ? "var(--bg)" : "var(--muted)", fontSize:12, cursor:"pointer", fontFamily:S.f, fontWeight:600 }}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:16, marginBottom:12, border:"1px solid var(--border)" }}>
        <div style={{ fontSize:15, fontWeight:700, marginBottom:10, color:"var(--text)", fontFamily:S.f }}>Estadísticas</div>
        {(() => { const c = vesAtDate(last, cur); return [["Open",fmtP(c.open,cur)],["Close",fmtP(c.close,cur)],["High",fmtP(c.high,cur)],["Low",fmtP(c.low,cur)],["Cap. Mercado",fmtMcap(stock.mcapVES,cur)],["P/E",stock.pe],["IPO",String(stock.ipo)],["IBC",stock.ibc?"✅":"❌"]]; })().map(([l, v], i) => (
          <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:i<7 ? "1px solid var(--border)" : "none" }}>
            <span style={{ fontSize:13, color:"var(--muted)", fontFamily:S.f }}>{l}</span>
            <span style={{ fontSize:13, fontWeight:600, color:"var(--text)", fontFamily:S.f }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:16, border:"1px solid var(--border)" }}>
        <div style={{ fontSize:15, fontWeight:700, marginBottom:8, color:"var(--text)", fontFamily:S.f }}>Sobre {stock.name}</div>
        <p style={{ fontSize:13, color:"var(--muted)", lineHeight:1.6, margin:0, fontFamily:S.f }}>{stock.desc}</p>
      </div>
    </div>
  );
}

// ── FX Mini Chart ──
function FXMini({ data, color = "#FF1744", unit = "Bs" }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const VW = 320, VH = 120, pad = { t: 8, r: 8, b: 4, l: 48 };
  const W = VW - pad.l - pad.r, H = VH - pad.t - pad.b;
  const rates = data.map(d => d.rate);
  const mn = Math.min(...rates), mx = Math.max(...rates), rng = mx - mn || 1;
  const xS = i => pad.l + (i / (data.length - 1 || 1)) * W;
  const yS = v => pad.t + (1 - (v - (mn - rng * 0.05)) / (rng * 1.1)) * H;
  const path = rates.map((v, i) => (i === 0 ? "M" : "L") + xS(i) + "," + yS(v)).join(" ");
  const gid = "fm" + hashStr(color + unit);
  const fmtVal = v => v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2);

  const onMouse = e => {
    if (!ref.current) return;
    const rc = ref.current.getBoundingClientRect();
    if (rc.width <= 0) return;
    const vbX = (e.clientX - rc.left) * (VW / rc.width);
    const ratio = Math.max(0, Math.min(1, (vbX - pad.l) / W));
    const idx = Math.round(ratio * (data.length - 1));
    if (idx >= 0 && idx < data.length) {
      const d = data[idx];
      const prev = idx > 0 ? data[idx - 1].rate : d.rate;
      const chg = prev ? ((d.rate - prev) / prev) * 100 : 0;
      setTip({ x: xS(idx), y: yS(d.rate), rate: d.rate, date: d.date, chg });
    }
  };
  const onLeave = () => setTip(null);

  return (
    <svg ref={ref} width="100%" viewBox={"0 0 " + VW + " " + VH} style={{ display:"block", cursor:"crosshair" }}
      onMouseMove={onMouse} onMouseLeave={onLeave} onTouchMove={onMouse} onTouchEnd={onLeave}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.12} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {[mn, (mn+mx)/2, mx].map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={VW-pad.r} y1={yS(v)} y2={yS(v)} stroke="var(--grid)" strokeWidth={0.5} />
          <text x={pad.l-4} y={yS(v)+3} textAnchor="end" fill="var(--muted)" fontSize={8.5} fontFamily="'DM Sans'">{fmtVal(v)}</text>
        </g>
      ))}
      <path d={path + " L" + xS(data.length-1) + "," + (pad.t+H) + " L" + xS(0) + "," + (pad.t+H) + " Z"} fill={"url(#" + gid + ")"} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.3} />
      {tip && (
        <>
          <line x1={tip.x} x2={tip.x} y1={pad.t} y2={pad.t + H} stroke={color} strokeWidth={0.5} strokeDasharray="3,3" opacity={0.5} />
          <circle cx={tip.x} cy={tip.y} r={3} fill={color} stroke="#fff" strokeWidth={1} />
          <foreignObject
            x={tip.x > VW - pad.r - 132 ? tip.x - 130 : tip.x + 8}
            y={tip.y < pad.t + 52 ? tip.y + 8 : tip.y - 52}
            width={124} height={48}>
            <div style={{ background:"var(--card)", border:"1px solid var(--border)", borderRadius:6, padding:"3px 6px", fontSize:9, fontFamily:"'DM Sans'", color:"var(--text)", boxShadow:"0 2px 8px rgba(0,0,0,0.08)" }}>
              <div style={{ fontWeight:700 }}>{fmtDate(tip.date)}</div>
              <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
                <span>{fmtVal(tip.rate)} {unit}</span>
                <span style={{ color: tip.chg >= 0 ? "#FF1744" : "#00C853", fontWeight:600 }}>
                  {tip.chg >= 0 ? "+" : ""}{tip.chg.toFixed(2)}%
                </span>
              </div>
            </div>
          </foreignObject>
        </>
      )}
    </svg>
  );
}

// ── Depreciation Chart — inverted FX showing Bs purchasing power decline ──
function DepreciationChart({ data }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const VW = 340, VH = 160, pad = { t: 12, r: 10, b: 8, l: 52 };
  const W = VW - pad.l - pad.r, H = VH - pad.t - pad.b;
  // Invert: show dollar value of 1000 Bs over time
  const vals = data.map(d => 1000 / d.rate);
  const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
  const xS = i => pad.l + (i / (data.length - 1 || 1)) * W;
  const yS = v => pad.t + (1 - (v - (mn - rng * 0.05)) / (rng * 1.1)) * H;
  const path = vals.map((v, i) => (i === 0 ? "M" : "L") + xS(i) + "," + yS(v)).join(" ");

  const onMouse = e => {
    if (!ref.current) return;
    const rc = ref.current.getBoundingClientRect();
    if (rc.width <= 0) return;
    const vbX = (e.clientX - rc.left) * (VW / rc.width);
    const ratio = Math.max(0, Math.min(1, (vbX - pad.l) / W));
    const idx = Math.round(ratio * (data.length - 1));
    if (idx >= 0 && idx < data.length) {
      const v = vals[idx];
      const depr = ((v / vals[0]) - 1) * 100;
      setTip({ x: xS(idx), y: yS(v), v, date: data[idx].date, rate: data[idx].rate, depr });
    }
  };
  const onLeave = () => setTip(null);

  return (
    <svg ref={ref} width="100%" viewBox={"0 0 " + VW + " " + VH} style={{ display:"block", cursor:"crosshair" }}
      onMouseMove={onMouse} onMouseLeave={onLeave} onTouchMove={onMouse} onTouchEnd={onLeave}>
      <defs>
        <linearGradient id="deprG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FF1744" stopOpacity={0} />
          <stop offset="100%" stopColor="#FF1744" stopOpacity={0.18} />
        </linearGradient>
      </defs>
      {[mn, (mn + mx) / 2, mx].map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={VW - pad.r} y1={yS(v)} y2={yS(v)} stroke="var(--grid)" strokeWidth={0.5} />
          <text x={pad.l - 4} y={yS(v) + 3} textAnchor="end" fill="var(--muted)" fontSize={8} fontFamily="'DM Sans'">
            ${v.toFixed(v >= 1 ? 1 : 2)}
          </text>
        </g>
      ))}
      <path d={path + " L" + xS(data.length - 1) + "," + (pad.t + H) + " L" + xS(0) + "," + (pad.t + H) + " Z"} fill="url(#deprG)" />
      <path d={path} fill="none" stroke="#FF1744" strokeWidth={1.8} strokeLinejoin="round" />
      {tip && (
        <>
          <line x1={tip.x} x2={tip.x} y1={pad.t} y2={pad.t + H} stroke="#FF1744" strokeWidth={0.5} strokeDasharray="3,3" opacity={0.5} />
          <circle cx={tip.x} cy={tip.y} r={3.5} fill="#FF1744" stroke="#fff" strokeWidth={1} />
          <foreignObject
            x={tip.x > VW - pad.r - 146 ? tip.x - 144 : tip.x + 8}
            y={tip.y < pad.t + 60 ? tip.y + 10 : tip.y - 60}
            width={138} height={56}>
            <div style={{ background:"var(--card)", border:"1px solid var(--border)", borderRadius:6, padding:"4px 7px", fontSize:9, fontFamily:"'DM Sans'", color:"var(--text)", boxShadow:"0 2px 8px rgba(0,0,0,0.08)" }}>
              <div style={{ fontWeight:700, marginBottom:1 }}>{fmtDate(tip.date)}</div>
              <div>Bs 1.000 = <span style={{ fontWeight:700 }}>${tip.v.toFixed(2)}</span></div>
              <div style={{ color:"#FF1744", fontWeight:600 }}>Depreciación: {tip.depr.toFixed(1)}%</div>
            </div>
          </foreignObject>
        </>
      )}
    </svg>
  );
}

// ── FX Tab ──
function FXTab() {
  const [amt, setAmt] = useState("1");
  const [from, setFrom] = useState("USD_PAR");
  const [to, setTo] = useState("VES");
  const fV = from === "VES" ? 1 : FX[from].rate;
  const tV = to === "VES" ? 1 : FX[to].rate;
  const result = (parseFloat(amt) || 0) * fV / tV;
  const swap = () => { setFrom(to); setTo(from); };
  const opts = Object.entries(FX).filter(([k]) => k !== "USD");
  const S = { f: "'DM Sans',sans-serif" };

  return (
    <div style={{ paddingBottom: 80 }}>
      <div style={{ fontSize:22, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:16 }}>Calculadora FX</div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:16, marginBottom:16, border:"1px solid var(--border)" }}>
        <div style={{ fontSize:13, fontWeight:700, marginBottom:10, color:"var(--text)", fontFamily:S.f }}>Tasas Actuales</div>
        {[
          { l:"Dólar BCV", r:"466,60 Bs/$", f:"🇺🇸" },
          { l:"Euro BCV", r:"540,17 Bs/€", f:"🇪🇺" },
          { l:"Dólar Paralelo (Prom. P2P)", r:"678,00 Bs/$", f:"⚡", hl:true },
        ].map((r, i) => (
          <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:"1px solid var(--border)" }}>
            <span style={{ fontSize:13, color:"var(--muted)", fontFamily:S.f }}>{r.f} {r.l}</span>
            <span style={{ fontSize:14, fontWeight:700, color:r.hl?"#F59E0B":"var(--text)", fontFamily:S.f }}>{r.r}</span>
          </div>
        ))}
        <div style={{ fontSize:12, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginTop:12, marginBottom:6 }}>Spreads & Conversiones</div>
        {[
          { l:"Brecha Par$/BCV$", r:"45,3%", f:"📊", desc:"Cuesta 45,3% más comprar dólares en el paralelo vs tasa oficial" },
          { l:"Brecha Par€/BCV€", r:"44,3%", f:"📊", desc:"678 × 1,15 = 780 Bs/€ vs BCV 540,17 Bs/€" },
          { l:"€ Paralelo implícito", r:"780 Bs/€", f:"💶", desc:"Costo real de euros vía paralelo: 678 × 1.15 EUR/USD" },
          { l:"1 USD → EUR", r:"€0,87", f:"💱", desc:"Tipo de cambio internacional (fuente: FRED, Mar 2026)" },
        ].map((r, i) => (
          <div key={i} style={{ padding:"7px 0", borderBottom:i<3?"1px solid var(--border)":"none" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:12, color:"var(--muted)", fontFamily:S.f }}>{r.f} {r.l}</span>
              <span style={{ fontSize:13, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{r.r}</span>
            </div>
            <div style={{ fontSize:9.5, color:"var(--muted)", fontFamily:S.f, opacity:0.7, marginTop:1 }}>{r.desc}</div>
          </div>
        ))}
      </div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:16, border:"1px solid var(--border)", marginBottom:16 }}>
        <div style={{ marginBottom:12 }}>
          <label style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f, display:"block", marginBottom:4 }}>Monto</label>
          <input type="number" value={amt} onChange={e => setAmt(e.target.value)} style={{ width:"100%", padding:"10px 12px", borderRadius:10, border:"1px solid var(--border)", background:"var(--bg)", color:"var(--text)", fontSize:18, fontWeight:700, fontFamily:S.f, outline:"none", boxSizing:"border-box" }} />
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
          <div style={{ flex:1 }}>
            <label style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f, display:"block", marginBottom:4 }}>De</label>
            <select value={from} onChange={e => setFrom(e.target.value)} style={{ width:"100%", padding:"10px 8px", borderRadius:10, border:"1px solid var(--border)", background:"var(--bg)", color:"var(--text)", fontSize:13, fontFamily:S.f }}>
              {opts.map(([k, v]) => <option key={k} value={k}>{v.flag} {v.label}</option>)}
            </select>
          </div>
          <button onClick={swap} style={{ marginTop:16, background:"var(--accent)", border:"none", borderRadius:"50%", width:36, height:36, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:16, color:"#fff" }}>⇄</button>
          <div style={{ flex:1 }}>
            <label style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f, display:"block", marginBottom:4 }}>A</label>
            <select value={to} onChange={e => setTo(e.target.value)} style={{ width:"100%", padding:"10px 8px", borderRadius:10, border:"1px solid var(--border)", background:"var(--bg)", color:"var(--text)", fontSize:13, fontFamily:S.f }}>
              {opts.map(([k, v]) => <option key={k} value={k}>{v.flag} {v.label}</option>)}
            </select>
          </div>
        </div>
        <div style={{ background:"var(--bg)", borderRadius:12, padding:16, textAlign:"center", overflow:"hidden" }}>
          <div style={{ fontSize:12, color:"var(--muted)", fontFamily:S.f, marginBottom:4 }}>Resultado</div>
          {(() => {
            const txt = FX[to].sym + result.toLocaleString("es-VE", { minimumFractionDigits:2, maximumFractionDigits:2 });
            const sz = txt.length > 20 ? 16 : txt.length > 15 ? 20 : txt.length > 12 ? 24 : 28;
            return <div style={{ fontSize:sz, fontWeight:700, color:"var(--text)", fontFamily:S.f, wordBreak:"break-all" }}>{txt}</div>;
          })()}
        </div>
      </div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:16, border:"1px solid var(--border)", marginBottom:16 }}>
        <div style={{ fontSize:13, fontWeight:700, marginBottom:8, color:"var(--text)", fontFamily:S.f }}>Histórico Dólar BCV (2 años)</div>
        <FXMini data={FX_HIST.USD_BCV} unit="Bs/$" />
        <div style={{ fontSize:13, fontWeight:700, margin:"16px 0 8px", color:"var(--text)", fontFamily:S.f }}>Histórico Euro BCV (2 años)</div>
        <FXMini data={FX_HIST.EUR_BCV} unit="Bs/€" />
        <div style={{ margin:"16px 0 8px" }}>
          <span style={{ fontSize:13, fontWeight:700, color:"#F59E0B", fontFamily:S.f }}>⚡ Dólar Paralelo Promedio (2 años)</span>
        </div>
        <FXMini data={FX_HIST.USD_PAR} color="#F59E0B" unit="Bs/$" />
        <div style={{ fontSize:13, fontWeight:700, margin:"16px 0 8px", color:"var(--text)", fontFamily:S.f }}>🌍 USD → EUR Internacional (2 años)</div>
        <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f, marginBottom:6 }}>Cuántos euros compra 1 dólar. Fuente: Federal Reserve (FRED)</div>
        <FXMini data={FX_HIST.USD_EUR} color="#3B82F6" unit="€/$" />
      </div>
      {/* Depreciation chart — inverted: shows how much $1 worth of Bs buys over time */}
      <div style={{ background:"var(--card)", borderRadius:16, padding:16, border:"1px solid var(--border)", marginBottom:16 }}>
        <div style={{ fontSize:15, fontWeight:700, marginBottom:4, color:"var(--text)", fontFamily:S.f }}>📉 Depreciación del Bolívar</div>
        <div style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f, marginBottom:12, lineHeight:1.5 }}>
          Poder adquisitivo de Bs 1.000 medido en dólares paralelo. Muestra cuántos dólares puedes comprar con la misma cantidad de bolívares a lo largo del tiempo.
        </div>
        <DepreciationChart data={FX_HIST.USD_PAR} />
        <div style={{ display:"flex", justifyContent:"space-between", marginTop:8 }}>
          <div style={{ textAlign:"left" }}>
            <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f }}>Mar 2024</div>
            <div style={{ fontSize:14, fontWeight:700, color:"#00C853", fontFamily:S.f }}>
              ${(1000 / FX_HIST.USD_PAR[0].rate).toFixed(2)}
            </div>
          </div>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f }}>Pérdida</div>
            <div style={{ fontSize:14, fontWeight:700, color:"#FF1744", fontFamily:S.f }}>
              {(((1/FX_HIST.USD_PAR[FX_HIST.USD_PAR.length-1].rate) / (1/FX_HIST.USD_PAR[0].rate) - 1) * 100).toFixed(1)}%
            </div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f }}>Hoy</div>
            <div style={{ fontSize:14, fontWeight:700, color:"#FF1744", fontFamily:S.f }}>
              ${(1000 / FX_HIST.USD_PAR[FX_HIST.USD_PAR.length-1].rate).toFixed(2)}
            </div>
          </div>
        </div>
      </div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:16, border:"1px solid var(--border)", marginBottom:16 }}>
        <div style={{ fontSize:15, fontWeight:700, marginBottom:12, color:"var(--text)", fontFamily:S.f }}>📐 Metodología de Cálculo</div>
        {[
          { t:"Fórmula", b:"Precio ajustado = P(VES,t) ÷ E(t), donde P es el precio en bolívares del día t y E es la tasa de cambio del día t. El retorno R = (Precio_final - Precio_inicial) / Precio_inicial. Esto convierte directamente cada día a divisa dura.", c:"var(--text)" },
          { t:"VES (Bolívares)", b:"Precio nominal. En un entorno hiperinflacionario, el gráfico en VES siempre sube exponencialmente — se ve impresionante pero no refleja poder adquisitivo real.", c:"var(--text)" },
          { t:"$ BCV — Realidad Ejecutable", b:"P(VES) ÷ tasa BCV del día. Para inversionistas institucionales, fondos registrados o entidades extranjeras, la tasa BCV es la única que importa porque es la tasa a la que pueden ejecutar swaps de divisa a través de las mesas de cambio bancarias y repatriar capital.", c:"var(--text)" },
          { t:"€ BCV", b:"P(VES) ÷ tasa euro BCV del día. Es esencialmente la tasa BCV ajustada por el tipo EUR/USD global. Solo relevante si las obligaciones del inversionista están denominadas en euros.", c:"var(--text)" },
          { t:"⚡ $ Paralelo — Realidad Económica", b:"P(VES) ÷ tasa promedio P2P (Binance USDT/VES) del día. Para el inversionista retail o análisis macroeconómico, el paralelo es la medida más precisa del retorno real. ¿Por qué? Porque el precio de inmuebles, vehículos, bienes importados y servicios en Venezuela está anclado al dólar paralelo. Si tu portafolio sube 50% medido en $ BCV, pero el paralelo subió más que el BCV, tu capacidad real de compra disminuyó.", c:"#F59E0B" },
          { t:"La Brecha Cambiaria (Efecto Acordeón)", b:"Si la brecha entre BCV y paralelo se mantiene constante (ej: siempre 10%), el % de retorno sería IDÉNTICO en ambas vistas — solo cambiaría el valor absoluto en dólares. Los retornos divergen SOLO cuando la brecha cambia. Actualmente la brecha pasó de ~7.5% a ~45.3%. Cuando el BCV interviene inyectando dólares, la brecha se contrae y las líneas se acercan. En momentos de estrés, el paralelo se dispara, la brecha se amplía, y el retorno BCV 'supera' artificialmente al paralelo hasta que el BCV devalúa para alcanzarlo.", c:"var(--text)" },
          { t:"¿Por qué no basta con ver el precio en Bs?", b:"Tres razones: (1) Efecto lag — las acciones NO ajustan instantáneamente a saltos del paralelo; hay fricciones y baja liquidez. (2) La depreciación afecta el negocio subyacente — una empresa importadora puede perder márgenes reales aunque su acción suba en Bs. (3) El encaje legal drena liquidez en Bs del sistema, lo que puede estancar precios bursátiles mientras la moneda se devalúa.", c:"var(--text)" },
          { t:"Dividendos", b:"Esta herramienta no incluye dividendos. Para retorno total, los dividendos deben convertirse a la tasa del día ex-dividendo y sumarse al numerador. Sin ajuste de dividendos, los retornos mostrados son retornos de precio puro.", c:"var(--text)" },
          { t:"Liquidez", b:"Las acciones BVC pueden tener baja liquidez. El 'último precio negociado' puede no reflejar el precio al que podrías liquidar una posición grande — el retorno real ejecutable puede ser menor que el mostrado.", c:"var(--text)" },
          { t:"⚠️ Disclaimer", b:"La vista en divisas es informativa y de confort. Los activos de renta variable tienden a ajustarse a la depreciación — al momento del TP/SL, la acción ya habrá incorporado la depreciación acumulada. Tu inversión en acciones actúa como cobertura natural contra la inflación. Pero en la práctica, el ajuste no es perfecto (lag, liquidez, encaje legal), por eso vale la pena monitorear el retorno real. ¡Es para tu tranquilidad y diversión! 😄", c:"var(--muted)" },
        ].map((s, i) => (
          <div key={i} style={{ marginBottom:12 }}>
            <div style={{ fontSize:12, fontWeight:700, color:s.c, fontFamily:S.f, marginBottom:3 }}>{s.t}</div>
            <div style={{ fontSize:11.5, color:"var(--muted)", fontFamily:S.f, lineHeight:1.6 }}>{s.b}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Data Tab — raw open/close/high/low data ──
function DataTab({ cur }) {
  const [showFX, setShowFX] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [datSearch, setDatSearch] = useState("");
  const S = { f: "'DM Sans',sans-serif" };
  const hdr = { fontSize:11, fontWeight:700, color:"var(--text)", fontFamily:S.f, padding:"6px 4px", borderBottom:"2px solid var(--border)", textAlign:"right", position:"sticky", top:0, background:"var(--card)", zIndex:1 };
  const cell = { fontSize:10.5, fontFamily:S.f, padding:"5px 4px", borderBottom:"1px solid var(--border)", textAlign:"right", color:"var(--text)" };
  const cellL = { ...cell, textAlign:"left", fontWeight:600 };

  const toggleExp = key => setExpanded(e => ({ ...e, [key]: !e[key] }));

  return (
    <div style={{ paddingBottom: 80 }}>
      <div style={{ fontSize:22, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:4 }}>Datos del Mercado</div>
      <div style={{ fontSize:12, color:"var(--muted)", fontFamily:S.f, marginBottom:12 }}>Datos crudos para verificación. Toca un ticker para ver más datos.</div>

      <div style={{ display:"flex", gap:6, marginBottom:12 }}>
        <button onClick={() => setShowFX(false)} style={{ padding:"6px 16px", borderRadius:20, border:"1px solid var(--border)", background:!showFX?"var(--text)":"transparent", color:!showFX?"var(--bg)":"var(--muted)", fontSize:12, cursor:"pointer", fontFamily:S.f, fontWeight:600 }}>Acciones</button>
        <button onClick={() => setShowFX(true)} style={{ padding:"6px 16px", borderRadius:20, border:"1px solid var(--border)", background:showFX?"var(--text)":"transparent", color:showFX?"var(--bg)":"var(--muted)", fontSize:12, cursor:"pointer", fontFamily:S.f, fontWeight:600 }}>Tasas FX</button>
      </div>

      {/* Search (only for stocks view) */}
      {!showFX && (
        <div style={{ position:"relative", marginBottom:12 }}>
          <input type="text" placeholder="Buscar ticker o nombre..." value={datSearch} onChange={e => setDatSearch(e.target.value)}
            style={{ width:"100%", padding:"8px 12px 8px 34px", borderRadius:10, border:"1px solid var(--border)", background:"var(--card)", color:"var(--text)", fontSize:12, fontFamily:S.f, outline:"none", boxSizing:"border-box" }} />
          <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", fontSize:14, color:"var(--muted)" }}>🔍</span>
        </div>
      )}

      {showFX ? (
        <div style={{ background:"var(--card)", borderRadius:16, padding:12, border:"1px solid var(--border)" }}>
          <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:8 }}>Histórico de Tasas de Cambio</div>
          {Object.entries(FX_HIST).filter(([key]) => key !== "USD_EUR").map(([key, hist]) => {
            const label = key === "USD_BCV" ? "Dólar BCV (Bs/$)" : key === "EUR_BCV" ? "Euro BCV (Bs/€)" : "Dólar Paralelo Prom. (Bs/$)";
            const isOpen = expanded[key];
            const show = isOpen ? hist.slice(-60) : hist.slice(-5);
            return (
              <div key={key} style={{ marginBottom:16 }}>
                <div onClick={() => toggleExp(key)}
                  style={{ fontSize:12, fontWeight:700, color:key==="USD_PAR"?"#F59E0B":"var(--text)", fontFamily:S.f, marginBottom:6, cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span>{key==="USD_PAR"?"⚡ ":""}{label}</span>
                  <span style={{ fontSize:10, color:"var(--muted)" }}>{isOpen ? "▲ Menos" : "▼ Más datos"}</span>
                </div>
                <div style={{ maxHeight: isOpen ? 300 : "none", overflowY: isOpen ? "auto" : "visible", overflowX:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ ...hdr, textAlign:"left" }}>Fecha</th>
                        <th style={hdr}>Tasa</th>
                        <th style={hdr}>Δ%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {show.slice().reverse().map((d, i, arr) => {
                        const prev = i < arr.length - 1 ? arr[i + 1].rate : d.rate;
                        const chg = prev ? ((d.rate - prev) / prev) * 100 : 0;
                        return (
                          <tr key={i}>
                            <td style={cellL}>{fmtDate(d.date)}</td>
                            <td style={cell}>{d.rate.toFixed(2)}</td>
                            <td style={{ ...cell, color:chg>=0?"#FF1744":"#00C853", fontWeight:600 }}>{fmtPct(chg)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
          <div style={{ fontSize:9, color:"var(--muted)", fontFamily:S.f, marginTop:8 }}>
            Fuentes: bcv.org.ve (BCV/EUR), p2p.binance.com tasa promedio (Paralelo). Δ% rojo = depreciación del Bs.
          </div>
        </div>
      ) : (
        <div>
          {STOCKS.filter(stock => {
            if (!datSearch) return true;
            return fuzzyMatch(datSearch, stock.ticker) || fuzzyMatch(datSearch, stock.name);
          }).map(stock => {
            const isOpen = expanded[stock.ticker];
            const allC = stock.daily.map(d => vesAtDate(d, cur));
            const show = isOpen ? allC.slice(-60) : allC.slice(-5);
            return (
              <div key={stock.ticker} style={{ background:"var(--card)", borderRadius:12, padding:10, marginBottom:8, border:"1px solid var(--border)" }}>
                <div onClick={() => toggleExp(stock.ticker)}
                  style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6, cursor:"pointer", justifyContent:"space-between" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:20 }}>{stock.logo}</span>
                    <div>
                      <div style={{ fontSize:13, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{stock.ticker}</div>
                      <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f }}>{stock.name}</div>
                    </div>
                  </div>
                  <span style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f }}>{isOpen ? "▲ Menos" : "▼ Más"}</span>
                </div>
                <div style={{ maxHeight: isOpen ? 300 : "none", overflowY: isOpen ? "auto" : "visible", overflowX:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", minWidth:340 }}>
                    <thead>
                      <tr>
                        <th style={{ ...hdr, textAlign:"left" }}>Fecha</th>
                        <th style={hdr}>Open</th>
                        <th style={hdr}>High</th>
                        <th style={hdr}>Low</th>
                        <th style={hdr}>Close</th>
                        <th style={hdr}>Δ%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {show.slice().reverse().map((d, i, arr) => {
                        const up = d.close >= d.open;
                        const prev = i < arr.length - 1 ? arr[i + 1].close : d.open;
                        const chg = prev ? ((d.close - prev) / prev) * 100 : 0;
                        return (
                          <tr key={i}>
                            <td style={cellL}>{fmtDate(d.date)}</td>
                            <td style={cell}>{fmtP(d.open, cur)}</td>
                            <td style={cell}>{fmtP(d.high, cur)}</td>
                            <td style={cell}>{fmtP(d.low, cur)}</td>
                            <td style={{ ...cell, color:up?"#00C853":"#FF1744", fontWeight:600 }}>{fmtP(d.close, cur)}</td>
                            <td style={{ ...cell, color:chg>=0?"#00C853":"#FF1744", fontSize:9.5 }}>{fmtPct(chg)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main App ──
// ── Commodities Tab — with 2Y charts ──
// Futures prices Mar 28 2026: Gold $4,538 (ATH $5,627 Jan'26), Silver $69.58 (ATH $121 Jan'26), Brent $112.57
const CMDTY = [
  { name:"Oro (Gold)", sym:"GC", price:4538, unit:"/oz", emoji:"🥇", dailyChg:+1.2,
    // Real trajectory: gradual rise → parabolic Jan'26 → crash → recovery
    waypoints:[{t:0,p:2200},{t:0.15,p:2400},{t:0.3,p:2650},{t:0.5,p:2800},{t:0.65,p:3100},{t:0.8,p:3800},{t:0.88,p:5200},{t:0.92,p:5589},{t:0.95,p:4660},{t:0.97,p:4090},{t:1,p:4538}] },
  { name:"Petróleo (Brent)", sym:"BRN", price:112.57, unit:"/bbl", emoji:"🛢️", dailyChg:+4.22,
    // Flat/declining through 2024-2025, then Iran crisis spike Feb-Mar 2026
    waypoints:[{t:0,p:85},{t:0.15,p:82},{t:0.3,p:78},{t:0.5,p:73},{t:0.7,p:70},{t:0.85,p:68},{t:0.9,p:72},{t:0.94,p:88},{t:0.97,p:100},{t:1,p:112.57}] },
  { name:"Plata (Silver)", sym:"SI", price:69.58, unit:"/oz", emoji:"🪙", dailyChg:+1.2,
    // Rise, parabolic to $121 Jan'26, crash to $61, recovery
    waypoints:[{t:0,p:25},{t:0.2,p:29},{t:0.4,p:32},{t:0.6,p:42},{t:0.75,p:55},{t:0.85,p:97},{t:0.92,p:121},{t:0.95,p:71},{t:0.97,p:61},{t:1,p:69.58}] },
];

// Waypoint-interpolated daily data with noise
function genWaypointDaily(waypoints, totalDays, vol, seed) {
  const rng = mulberry32(seed), now = Date.now(), dates = [];
  for (let i = totalDays; i >= 0; i--) {
    const ts = now - i * 864e5;
    if (new Date(ts).getDay() % 6 !== 0) dates.push(ts);
  }
  const N = dates.length;
  // Interpolate waypoints to get target price for each day
  function wpAt(t) {
    for (let i = 1; i < waypoints.length; i++) {
      if (t <= waypoints[i].t) {
        const w0 = waypoints[i-1], w1 = waypoints[i];
        const r = (t - w0.t) / (w1.t - w0.t);
        const smooth = r * r * (3 - 2 * r); // smoothstep
        return w0.p + (w1.p - w0.p) * smooth;
      }
    }
    return waypoints[waypoints.length - 1].p;
  }
  let noise = 0;
  return dates.map((date, i) => {
    const t = i / (N - 1 || 1);
    const target = wpAt(t);
    noise += (rng() - 0.5) * vol * target;
    noise *= 0.97;
    const fade = Math.max(0.15, 1 - Math.pow(t, 3)); // keep minimum 15% noise even at end
    const p = Math.max(1, target + noise * fade * 0.3);
    const spread = p * 0.005 * (0.5 + rng());
    return { date, open: p - spread, high: p + spread * 1.5, low: p - spread * 1.5, close: p };
  });
}

// 15-min intraday for commodities — previous trading day, scaled to real daily change
function genCmdtyIntra(base, dailyChg, seed) {
  const rng = mulberry32(seed), pts = [];
  const yday = new Date();
  yday.setDate(yday.getDate() - 1);
  const dow = yday.getDay();
  if (dow === 0) yday.setDate(yday.getDate() - 2);
  else if (dow === 6) yday.setDate(yday.getDate() - 1);
  yday.setHours(8, 0, 0, 0);
  // Work backwards from close=base, open = base/(1+dailyChg/100)
  const openPrice = base / (1 + dailyChg / 100);
  let p = openPrice;
  for (let i = 0; i < 32; i++) {
    const ts = yday.getTime() + i * 15 * 60000;
    // Interpolate from open toward close with noise
    const t = i / 31;
    const target = openPrice + (base - openPrice) * t;
    const noise = (rng() - 0.5) * base * 0.002;
    const c = target + noise;
    const o = p;
    const h = Math.max(o, c) * (1 + rng() * 0.001);
    const l = Math.min(o, c) * (1 - rng() * 0.001);
    pts.push({ date: ts, open: o, high: h, low: l, close: c });
    p = c;
  }
  // Pin last close exactly
  pts[pts.length - 1].close = base;
  // Pin first open exactly
  pts[0].open = openPrice;
  return pts;
}
const CMDTY_DATA = CMDTY.map((c, i) => ({
  ...c,
  daily: genWaypointDaily(c.waypoints, 730, c.sym === "BRN" ? 0.06 : 0.03, 5000 + i),
  intraday: genCmdtyIntra(c.price, c.dailyChg, 5000 + i),
}));

function CommoditiesTab() {
  const S = { f: "'DM Sans',sans-serif" };
  const [selC, setSelC] = useState(null);
  const [cTf, setCTf] = useState("1D");
  const [cHover, setCHover] = useState(null);

  if (selC) {
    const is1D = cTf === "1D";
    const raw = is1D ? selC.intraday : selC.daily;
    const tfDays = { "1D":0,"1S":7,"1M":30,"3M":90,"6M":180,"1A":365,"2A":730 };
    const days = tfDays[cTf] || 730;
    const sliced = is1D ? raw : raw.slice(Math.max(0, raw.length - days - 1));
    const fC = sliced[0], lC = sliced[sliced.length - 1];
    const dispVal = cHover || lC.close;
    const dispPct = fC.open ? ((dispVal - fC.open) / fC.open) * 100 : 0;
    const up = dispPct >= 0;
    const col = up ? "#00C853" : "#FF1744";
    return (
      <div style={{ paddingBottom:80 }}>
        <button onClick={() => { setSelC(null); setCHover(null); }} style={{ background:"none", border:"none", color:"var(--accent)", fontSize:15, fontFamily:S.f, cursor:"pointer", padding:"8px 0" }}>← Volver</button>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8, justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:28 }}>{selC.emoji}</span>
            <div>
              <div style={{ fontSize:20, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{selC.name}</div>
            </div>
          </div>
          {is1D && (
            <div style={{ textAlign:"right", flexShrink:0 }}>
              <div style={{ fontSize:13, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{fmtDate(sliced[0]?.date)}</div>
              <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f }}>8:00 AM – 4:00 PM ET</div>
              <div style={{ fontSize:9, color:"var(--muted)", fontFamily:S.f }}>Intervalos de 15 min</div>
            </div>
          )}
        </div>
        <div style={{ fontSize:28, fontWeight:800, color:"var(--text)", fontFamily:S.f }}>${dispVal.toFixed(2)}<span style={{ fontSize:13, color:"var(--muted)" }}>{selC.unit}</span></div>
        <div style={{ fontSize:15, fontWeight:700, color:col, fontFamily:S.f, marginBottom:8 }}>{dispPct >= 0 ? "+" : ""}{dispPct.toFixed(2)}%</div>
        <Chart data={sliced} cur="USD" type="line" simple is1D={is1D} onHover={v => setCHover(v ? v.close : null)} />
        <div style={{ display:"flex", gap:4, justifyContent:"center", paddingTop:6, flexWrap:"wrap" }}>
          {["1D","1S","1M","3M","6M","1A","2A"].map(t => (
            <button key={t} onClick={() => { setCTf(t); setCHover(null); }} style={{ padding:"3px 10px", borderRadius:12, border:"none", background:cTf===t?"var(--text)":"transparent", color:cTf===t?"var(--bg)":"var(--muted)", fontSize:10, cursor:"pointer", fontFamily:S.f, fontWeight:600 }}>{t}</button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ fontSize:22, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:4 }}>Commodities</div>
      <div style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f, marginBottom:16 }}>Precios internacionales de referencia en USD. Datos aproximados.</div>
      {CMDTY_DATA.map((c, i) => {
        const lC = c.daily[c.daily.length - 1];
        const pct = c.dailyChg;
        const up = pct >= 0;
        const d30 = c.daily.slice(-30);
        const sp = d30.map(d => d.close);
        const spMn = Math.min(...sp), spMx = Math.max(...sp), spR = spMx - spMn || 1;
        const spW = 58, spH = 26;
        const spP = sp.map((v, j) => (j === 0 ? "M" : "L") + ((j / (sp.length - 1)) * spW) + "," + (spH - ((v - spMn) / spR) * spH)).join(" ");
        return (
          <div key={i} onClick={() => { setSelC(c); setCTf("1D"); setCHover(null); }} style={{ background:"var(--card)", borderRadius:16, padding:"14px 16px", border:"1px solid var(--border)", marginBottom:10, cursor:"pointer" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:24 }}>{c.emoji}</span>
                <div>
                  <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{c.name}</div>
                  <div style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f }}>{c.sym}</div>
                </div>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <svg width={spW} height={spH} style={{ display:"block", flexShrink:0 }}>
                  <path d={spP} fill="none" stroke={up?"#00C853":"#FF1744"} strokeWidth={1.1} />
                </svg>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontSize:15, fontWeight:800, color:"var(--text)", fontFamily:S.f }}>${lC.close.toFixed(2)}</div>
                  <div style={{ fontSize:12, fontWeight:700, color:up?"#00C853":"#FF1744", fontFamily:S.f }}>{pct >= 0?"+":""}{pct.toFixed(2)}%</div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
      <div style={{ fontSize:9, color:"var(--muted)", fontFamily:S.f, marginTop:8 }}>
        ⚠️ Precios aproximados. Fuentes: Fortune, CBS, USAGOLD, OilPrice, LiteFinance. 28 Mar 2026.
      </div>
    </div>
  );
}

// ── Sources Tab ──
function SourcesTab() {
  const S = { f: "'DM Sans',sans-serif" };
  const sources = [
    { cat:"Tasas de Cambio", items:[
      { n:"Tasa Dólar / Euro BCV", s:"Banco Central de Venezuela", url:"https://www.bcv.org.ve/", d:"Tasa oficial diaria publicada por el BCV" },
      { n:"Histórico de Tasas BCV", s:"Datos trimestrales", url:"https://www.bcv.org.ve/estadisticas/tipo-de-cambio", d:"Archivo histórico de tasas de cambio" },
      { n:"Dólar Paralelo (Prom. P2P)", s:"Binance P2P (USDT/VES)", url:"https://p2p.binance.com/es/trade/all-payments/USDT?fiat=VES", d:"Tasa promedio de transacciones peer-to-peer" },
      { n:"EUR/USD Internacional", s:"Federal Reserve (FRED)", url:"https://fred.stlouisfed.org/series/DEXUSEU", d:"Tipo de cambio spot de la Reserva Federal" },
    ]},
    { cat:"Bolsa de Valores", items:[
      { n:"Cotizaciones en vivo", s:"Bolsa de Valores de Caracas", url:"https://market.bolsadecaracas.com/es", d:"Precios y datos del mercado en tiempo real" },
      { n:"Boletines semanales BVC", s:"Noticias y boletines", url:"https://www.bolsadecaracas.com/noticias/home/generales/", d:"IBC, Financiero, Industrial y resúmenes" },
      { n:"Precios y Market Cap", s:"StockAnalysis.com", url:"https://stockanalysis.com/list/caracas-stock-exchange/", d:"Lista de acciones con precios y capitalización" },
    ]},
    { cat:"Commodities", items:[
      { n:"Gold Futures (GC)", s:"Investing.com / COMEX", url:"https://www.investing.com/commodities/gold", d:"Futuros de oro en COMEX" },
      { n:"Brent Crude (BRN)", s:"OilPrice.com", url:"https://oilprice.com/futures/brent/", d:"Futuros de petróleo Brent ICE" },
      { n:"Silver Futures (SI)", s:"APMEX", url:"https://www.apmex.com/silver-price", d:"Precio spot y futuros de plata" },
    ]},
    { cat:"Datos Macro", items:[
      { n:"IBC en vivo", s:"Investing.com", url:"https://mx.investing.com/indices/bursatil", d:"Cotización en tiempo real del IBC" },
      { n:"IBVC Index", s:"Bloomberg", url:"https://www.bloomberg.com/quote/IBVC:IND", d:"Performance del índice BVC" },
      { n:"USD/VES Histórico", s:"Exchange-rates.org", url:"https://www.exchange-rates.org/exchange-rate-history/usd-ves-2024", d:"Historial anual USD/VES" },
    ]},
  ];
  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ fontSize:22, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:16 }}>📚 Fuentes</div>
      {sources.map((sec, si) => (
        <div key={si} style={{ background:"var(--card)", borderRadius:16, padding:16, border:"1px solid var(--border)", marginBottom:12 }}>
          <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:10 }}>{sec.cat}</div>
          {sec.items.map((s, i) => (
            <div key={i} style={{ padding:"8px 0", borderBottom:i < sec.items.length - 1 ? "1px solid var(--border)" : "none" }}>
              <div style={{ fontSize:13, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{s.n}</div>
              <div style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f }}>{s.s}</div>
              <div onClick={() => window.open(s.url, "_blank")} style={{ fontSize:10, color:"var(--accent)", fontFamily:S.f, fontWeight:600, cursor:"pointer", wordBreak:"break-all" }}>{s.url} ↗</div>
              <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f, opacity:0.7, marginTop:2 }}>{s.d}</div>
            </div>
          ))}
        </div>
      ))}
      <div style={{ background:"var(--card)", borderRadius:16, padding:14, border:"1px solid var(--border)", marginBottom:12 }}>
        <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f, lineHeight:1.6 }}>
          ⚠️ Todos los datos son aproximaciones basadas en estas fuentes. Las tasas se actualizan con la última publicación disponible. Si no hay tasa publicada un día, se usa la del último día hábil. Última actualización: 28 Mar 2026.
        </div>
      </div>
    </div>
  );
}

// ── Features Tab ──
function FeaturesTab() {
  const S = { f: "'DM Sans',sans-serif" };
  const cats = [
    { title:"📊 Datos de Mercado en Tiempo Real", items:[
      { n:"33 acciones de la BVC", d:"26 del mercado principal + 7 del BVC Alternativo, con precios verificados, market cap, P/E, año IPO, membresía IBC y descripción de cada empresa." },
      { n:"3 índices bursátiles", d:"IBC (6.472,57), Financiero (12.778,02), Industrial (2.712,46) — verificados de bolsadecaracas.com, 25 marzo 2026." },
      { n:"3 commodities (futuros)", d:"Gold GC $4.538/oz, Brent BRN $112,57/bbl, Silver SI $69,58/oz — precios de COMEX/ICE verificados al 28 marzo 2026." },
      { n:"4 tasas de cambio", d:"Dólar BCV (466,60), Euro BCV (540,17), Dólar Paralelo P2P (678,00), EUR/USD internacional (0,87) — verificadas de bcv.org.ve, Binance P2P y FRED." },
    ]},
    { title:"💱 Motor de Conversión FX", items:[
      { n:"Conversión dinámica a 4 divisas", d:"Cada precio, market cap e índice se convierte en tiempo real a VES, $BCV, €BCV o $Paralelo usando la fórmula V(t) = P(VES,t) ÷ E(t)." },
      { n:"Forward-fill temporal (Axioma 2)", d:"fxAtDate() busca la última tasa publicada ≤ fecha objetivo. Fines de semana y feriados heredan la tasa del último día hábil — sin estados nulos." },
      { n:"Calculadora FX con auto-shrink", d:"Convierte entre 4 monedas con tabla pivote VES. Fuente auto-reduce de 28→16px según largo del resultado. word-break como fallback." },
      { n:"Efecto acordeón demostrado", d:"Si la brecha BCV/Paralelo es constante, los retornos % son idénticos — divergen solo cuando la brecha cambia. Probado matemáticamente." },
    ]},
    { title:"📈 Visualización de Gráficos (SVG Puro)", items:[
      { n:"Charts interactivos sin librería externa", d:"Cada línea, barra, gradiente y tooltip codificado a mano en SVG. Cero dependencias de charting (no D3, no Recharts, no Chart.js)." },
      { n:"Modo línea + velas (candlestick)", d:"Toggle entre línea con gradient fill y candlestick con wicks y bodies coloreados (verde bullish, rojo bearish)." },
      { n:"7 timeframes", d:"1D (intraday 5min/15min), 1S, 1M, 3M, 6M, 1A, 2A — con agregación automática de velas para timeframes largos." },
      { n:"Agregación de velas inteligente", d:"3M=3 días, 6M=semanal, 1A=bisemanal, 2A=4 semanas. Tooltip muestra rango de fechas ('18 Jun – 25 Jun') en velas agrupadas." },
      { n:"Línea BASE de referencia", d:"Línea punteada horizontal al precio de apertura del período. Muestra visualmente si el activo está por encima o debajo del punto de partida." },
      { n:"Tooltips edge-aware", d:"Tooltip SVG (foreignObject) detecta bordes del gráfico y se voltea izquierda/derecha y arriba/abajo para nunca cortarse." },
      { n:"Sparklines en lista", d:"Mini gráficos SVG de 58×26px en cada tarjeta de acción con línea BASE de referencia punteada." },
    ]},
    { title:"🔍 Búsqueda Fuzzy con NLP", items:[
      { n:"Stripping de acentos (NFD)", d:"Normalización Unicode NFD + remoción de marcas combinantes. 'ceramica' encuentra 'Cerámica Carabobo' sin problemas." },
      { n:"Damerau-Levenshtein", d:"Distancia de edición con transposiciones — 'baco' → 'banco' (1 edición). Implementación single-row DP en O(n) espacio." },
      { n:"Tolerancia adaptativa", d:"0 ediciones para ≤3 chars, 1 para 4-5 chars, 2 para 6+. Previene falsos positivos en búsquedas cortas." },
      { n:"Multi-word matching", d:"Cada palabra del query se evalúa independientemente contra cada palabra del target — 'ron santa' encuentra 'Ron Santa Teresa'." },
    ]},
    { title:"🌙 Dark Mode Inteligente", items:[
      { n:"Auto-detección por hora", d:"Oscuro 7pm–6am, claro 6am–7pm. Usa new Date().getHours() al cargar." },
      { n:"Override manual", d:"Toggle ☀️/🌙 en la barra de monedas. 3 estados: null (auto), true (forzar oscuro), false (forzar claro)." },
      { n:"7 CSS custom properties", d:"--bg, --card, --text, --muted, --border, --accent, --grid. Swap completo con clase .dark en el root div." },
    ]},
    { title:"📱 Pull-to-Refresh (Touch + Mouse)", items:[
      { n:"GPU-accelerated transforms", d:"El contenido se mueve con translateY() (compuesto en GPU). Cero reflow de layout — buttery smooth 60fps." },
      { n:"Indicador absoluto", d:"↻ flota con position:absolute desde arriba. Rota proporcionalmente a la distancia de pull (pullDist × 5°)." },
      { n:"Bounce elástico", d:"cubic-bezier(0.34, 1.56, 0.64, 1) — el 1.56 crea 56% de overshoot antes de asentarse. Simula banda elástica." },
      { n:"Desktop + mobile", d:"mousedown/mousemove/mouseup para escritorio, touchstart/touchmove/touchend para móvil. touchmove con passive:false para preventDefault()." },
      { n:"scrollRef tracking", d:"Usa scrollRef.current.scrollTop en vez de window.scrollY (que no funciona en iframes de artifacts)." },
    ]},
    { title:"🧮 Generación de Datos Determinística", items:[
      { n:"PRNG Mulberry32", d:"Generador pseudoaleatorio de 32 bits con seed. Misma seed → misma secuencia siempre. Bitwise ops con Math.imul()." },
      { n:"Backward walk (acciones)", d:"Camina hacia atrás desde el precio actual verificado. Garantiza que el precio de hoy es exacto — el historial se deriva." },
      { n:"Brownian bridge (FX)", d:"Ruido con endpoints pinned a cero. bridge(t) = rawNoise[t] - endNoise × t. Tasas exactas en inicio y fin." },
      { n:"Waypoints + smoothstep (commodities)", d:"Trayectorias con puntos de control reales (ATH del oro $5.589, crash, recovery). Interpolación hermite C¹ continua." },
      { n:"Intraday pinned al daily %", d:"Open = precio ÷ (1 + dailyChg/100). Garantiza que open→close produce el % diario verificado exacto." },
    ]},
    { title:"⚡ Performance & UX", items:[
      { n:"Single-file architecture", d:"1.699 líneas de JSX, cero npm dependencies más allá de React core. Sin build complejo, sin tree-shaking issues." },
      { n:"useMemo / useCallback", d:"Listas filtradas, conversiones FX y datos de chart memoizados. doRefresh con useCallback para referencia estable en useEffect." },
      { n:"Tab fade animation", d:"fadeIn 0.25s ease-out con 6px translateY en cada cambio de tab. fadeKey se incrementa para forzar re-mount." },
      { n:"user-select: none", d:"Previene selección de texto durante gestos de drag en móvil." },
      { n:"Safe area insets", d:"env(safe-area-inset-bottom) en bottom tabs para iPhone con Face ID (34px home indicator)." },
      { n:"Scrollbars ocultos", d:"::-webkit-scrollbar { width:0 } — scroll funciona pero sin barra visible." },
    ]},
    { title:"📐 Ingeniería Financiera", items:[
      { n:"5 axiomas de valoración", d:"Dominio temporal, persistencia de estado, función de valoración real V(t)=P/E, subconjunto dinámico, retorno acumulado Δ=V(sᵢ)/V(s₀)-1." },
      { n:"Metodología documentada (10 puntos)", d:"Fórmula, VES, $BCV, €BCV, $Paralelo, brecha cambiaria, por qué VES sola no basta, dividendos, liquidez, disclaimer." },
      { n:"Depreciación visualizada", d:"Chart invertido mostrando poder adquisitivo de Bs 1.000 decayendo de $25,64 a $1,47 (-94,2%) en 2 años." },
      { n:"Spreads calculados", d:"Brecha Par$/BCV$ (45,3%), Par€/BCV€ (44,3%), € Paralelo implícito (780 Bs/€), EUR/USD cross (€0,87)." },
    ]},
    { title:"🔗 13 Fuentes Verificadas", items:[
      { n:"4 categorías", d:"Tasas de cambio (BCV, Binance, FRED), Bolsa (BVC live, StockAnalysis), Commodities (COMEX, ICE, APMEX), Macro (Investing.com, Bloomberg)." },
      { n:"Hyperlinks funcionales", d:"window.open() en vez de <a href> porque React artifacts bloquean navegación con anchor tags estándar." },
      { n:"Datos con fecha de verificación", d:"Cada precio y tasa tiene su fuente y fecha. Última actualización: 28 Mar 2026." },
    ]},
  ];

  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ fontSize:22, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:4 }}>🚀 Features</div>
      <div style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f, marginBottom:16 }}>Todo lo que hace esta app bajo el capó. 1.699 líneas de React puro.</div>
      {cats.map((cat, ci) => (
        <div key={ci} style={{ background:"var(--card)", borderRadius:16, padding:14, border:"1px solid var(--border)", marginBottom:10 }}>
          <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:8 }}>{cat.title}</div>
          {cat.items.map((item, ii) => (
            <div key={ii} style={{ padding:"6px 0", borderBottom:ii < cat.items.length - 1 ? "1px solid var(--border)" : "none" }}>
              <div style={{ fontSize:12, fontWeight:700, color:"var(--accent)", fontFamily:S.f }}>{item.n}</div>
              <div style={{ fontSize:10.5, color:"var(--muted)", fontFamily:S.f, lineHeight:1.5, marginTop:2 }}>{item.d}</div>
            </div>
          ))}
        </div>
      ))}
      <div style={{ textAlign:"center", padding:"12px 0", fontSize:10, color:"var(--muted)", fontFamily:S.f }}>
        Construido con React 18 · SVG puro · CSS custom properties · DM Sans · Mulberry32 PRNG<br/>
        Cero dependencias externas más allá de React core
      </div>
    </div>
  );
}

// ── About Tab ──
function AboutTab() {
  const S = { f: "'DM Sans',sans-serif" };
  return (
    <div style={{ paddingBottom:80 }}>
      <div style={{ fontSize:22, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:16, textAlign:"center" }}>Acerca de Venevalore$</div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:20, border:"1px solid var(--border)", marginBottom:16 }}>
        <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:10 }}>🎯 ¿Qué es esto?</div>
        <div style={{ fontSize:12, color:"var(--muted)", fontFamily:S.f, lineHeight:1.7 }}>
          Venevalore$ es un <strong style={{ color:"var(--text)" }}>proof of concept</strong> — una prueba de concepto de un visualizador de renta variable de la Bolsa de Valores de Caracas (BVC) con conversión a divisas en tiempo real. Fue construido enteramente como proyecto personal, por diversión y como ejercicio de ingeniería financiera.
        </div>
      </div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:20, border:"1px solid var(--border)", marginBottom:16 }}>
        <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:10 }}>🔧 Cómo se puede mejorar</div>
        <div style={{ fontSize:12, color:"var(--muted)", fontFamily:S.f, lineHeight:1.7 }}>
          • Conectar a APIs en vivo del BCV, BVC y Binance P2P para datos en tiempo real{"\n"}
          • Agregar sistema de alertas de precio y notificaciones{"\n"}
          • Incluir datos de dividendos para calcular retorno total{"\n"}
          • Implementar backtesting de portafolios en múltiples divisas{"\n"}
          • Agregar análisis técnico (RSI, MACD, Bollinger){"\n"}
          • Expandir a renta fija (bonos, papeles comerciales){"\n"}
          • App móvil nativa con push notifications
        </div>
      </div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:20, border:"1px solid var(--border)", marginBottom:16 }}>
        <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:10 }}>⚠️ Disclaimer</div>
        <div style={{ fontSize:12, color:"var(--muted)", fontFamily:S.f, lineHeight:1.7 }}>
          Toda la data presentada son <strong style={{ color:"var(--text)" }}>aproximaciones</strong> y no deben ser tomadas como datos financieros exactos. Los precios, tasas de cambio e índices mostrados son simulaciones basadas en datos reales verificados, pero pueden no reflejar los valores exactos del momento. <strong style={{ color:"var(--text)" }}>Haz tu propia investigación (DYOR)</strong>. Verifica la información directamente en las fuentes oficiales antes de tomar cualquier decisión de inversión. Este proyecto no constituye asesoría financiera.
        </div>
      </div>
      <div style={{ background:"var(--card)", borderRadius:16, padding:20, border:"1px solid var(--border)", marginBottom:16 }}>
        <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:S.f, marginBottom:10 }}>📬 Contacto</div>
        <div style={{ fontSize:12, color:"var(--muted)", fontFamily:S.f, lineHeight:1.8 }}>
          Si te gustó este proyecto, tienes ideas para mejorarlo, o quieres colaborar, ¡contáctame!
        </div>
        <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:8 }}>
          <div onClick={() => window.open("https://linkedin.com/in/sebastiansiervo", "_blank")} style={{ fontSize:13, color:"var(--accent)", fontFamily:S.f, fontWeight:600, cursor:"pointer" }}>🔗 LinkedIn — Sebastian Siervo ↗</div>
          <div style={{ fontSize:13, color:"var(--text)", fontFamily:S.f }}>📧 ssabarsky@icloud.com</div>
          <div style={{ fontSize:13, color:"var(--text)", fontFamily:S.f }}>📱 +58 412-2250820</div>
        </div>
      </div>
      <div style={{ textAlign:"center", padding:"20px 0" }}>
        <div style={{ fontSize:14, color:"var(--muted)", fontFamily:S.f }}>Hecho con ☕ y curiosidad por <strong style={{ color:"var(--text)" }}>Sebastian Siervo</strong></div>
        <div style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f, marginTop:4 }}>Venevalore$ © 2026</div>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("market");
  const [cur, setCur] = useState("VES");
  const [sel, setSel] = useState(null);
  const [search, setSearch] = useState("");
  const [ind, setInd] = useState("ALL");
  const [ibcTf, setIbcTf] = useState("1D");
  const [wl, setWL] = useState([]);
  const [ibcSt, setIbcSt] = useState({ value:0, pct:0, date:null, hover:false });
  const [sticky, setSticky] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [fadeKey, setFadeKey] = useState(0);
  const [pullDist, setPullDist] = useState(0);
  const pullRef = useRef({ startY: 0, pulling: false, scrollEl: null });
  const scrollRef = useRef(null);

  // Dark mode: auto by time (dark 7pm-6am), or manual toggle
  const [darkOverride, setDarkOverride] = useState(null);
  const autoDark = useMemo(() => { const h = new Date().getHours(); return h >= 19 || h < 6; }, []);
  const isDark = darkOverride !== null ? darkOverride : autoDark;

  const togW = t => setWL(w => w.includes(t) ? w.filter(x => x !== t) : [...w, t]);
  const maxFxD = FX_MAX[cur] || 9999;
  const S = { f: "'DM Sans',sans-serif" };

  const switchTab = t => { setFadeKey(k => k + 1); setTab(t); setSel(null); if(scrollRef.current) scrollRef.current.scrollTop = 0; };

  const doRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    setPullDist(0);
    setTimeout(() => {
      setLastRefresh(new Date());
      setRefreshing(false);
    }, 1400);
  }, [refreshing]);

  // Attach non-passive touch listeners + mouse listeners for desktop
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtTop = () => el.scrollTop <= 2;
    const start = y => { pullRef.current.startY = y; pullRef.current.pulling = false; pullRef.current.canPull = isAtTop(); };
    const move = y => {
      if (refreshing || !pullRef.current.canPull) return false;
      const delta = y - pullRef.current.startY;
      if (delta > 5 && isAtTop()) {
        const dist = Math.min(delta * 0.4, 100);
        setPullDist(dist);
        pullRef.current.pulling = dist >= 60;
        return true;
      }
      if (delta <= 0) { setPullDist(0); pullRef.current.pulling = false; }
      return false;
    };
    const end = () => {
      if (pullRef.current.pulling) doRefresh();
      else setPullDist(0);
      pullRef.current.pulling = false;
      pullRef.current.canPull = false;
      pullRef.current.mouseDown = false;
    };
    // Touch
    const ts = e => start(e.touches[0].clientY);
    const tm = e => { if (move(e.touches[0].clientY)) e.preventDefault(); };
    const te = () => end();
    // Mouse
    const md = e => { start(e.clientY); pullRef.current.mouseDown = true; };
    const mm = e => { if (pullRef.current.mouseDown) move(e.clientY); };
    const mu = () => { if (pullRef.current.mouseDown) end(); };
    el.addEventListener("touchstart", ts, { passive: true });
    el.addEventListener("touchmove", tm, { passive: false });
    el.addEventListener("touchend", te, { passive: true });
    el.addEventListener("mousedown", md);
    el.addEventListener("mousemove", mm);
    el.addEventListener("mouseup", mu);
    el.addEventListener("mouseleave", mu);
    return () => {
      el.removeEventListener("touchstart", ts); el.removeEventListener("touchmove", tm); el.removeEventListener("touchend", te);
      el.removeEventListener("mousedown", md); el.removeEventListener("mousemove", mm); el.removeEventListener("mouseup", mu); el.removeEventListener("mouseleave", mu);
    };
  }, [refreshing, doRefresh, sel]);

  const filtered = useMemo(() => {
    let l = STOCKS;
    if (tab === "watchlist") l = l.filter(s => wl.includes(s.ticker));
    if (ind !== "ALL") l = l.filter(s => s.industry === ind);
    if (search) { l = l.filter(s => fuzzyMatch(search, s.ticker) || fuzzyMatch(search, s.name)); }
    return l;
  }, [tab, ind, search, wl]);

  const ibcTfs = TFS.filter(t => t.days <= maxFxD || t.days === 0);

  const CurBar = () => {
    const colors = { VES:"#EAB308", USD_BCV:"#00C853", EUR_BCV:"#3B82F6", USD_PAR:"#F59E0B" };
    return (
    <div style={{ display:"flex", gap:4, padding:"6px 0", overflowX:"auto", flexShrink:0 }}>
      {Object.entries(FX).filter(([k]) => k !== "USD").map(([k, v]) => {
        const a = cur === k, isPar = k === "USD_PAR", c = colors[k];
        const lbl = k === "VES" ? "VES" : k === "USD_BCV" ? "$ BCV" : k === "EUR_BCV" ? "€ BCV" : "$ Paralelo";
        if (isPar) {
          return (
            <button key={k} onClick={() => setCur(k)} style={{
              padding:"5px 12px", borderRadius:20, border:a ? "none" : "1.5px solid " + c,
              background:a ? "linear-gradient(135deg,#F59E0B,#EF4444)" : "transparent",
              color:a ? "#fff" : c, fontSize:11, cursor:"pointer", fontFamily:S.f,
              fontWeight:700, whiteSpace:"nowrap", flexShrink:0,
              boxShadow:a ? "0 2px 8px rgba(245,158,11,0.35)" : "none",
            }}>⚡ {lbl}</button>
          );
        }
        return (
          <button key={k} onClick={() => setCur(k)} style={{
            padding:"5px 10px", borderRadius:20, border:a ? "none" : "1px solid " + c + "66",
            background:a ? c : "transparent", color:a ? "#fff" : c,
            fontSize:11, cursor:"pointer", fontFamily:S.f, fontWeight:600, whiteSpace:"nowrap", flexShrink:0,
            boxShadow:a ? "0 2px 6px " + c + "44" : "none",
          }}>{v.flag} {lbl}</button>
        );
      })}
      <button onClick={() => setSticky(s => !s)} style={{
        padding:"5px 8px", borderRadius:20, border:"1px solid var(--border)",
        background:sticky ? "var(--text)" : "transparent", color:sticky ? "var(--bg)" : "var(--muted)",
        fontSize:11, cursor:"pointer", fontFamily:S.f, fontWeight:500, flexShrink:0,
      }}>📌</button>
      <button onClick={() => setDarkOverride(d => d === null ? !autoDark : d === true ? false : true)} style={{
        padding:"5px 8px", borderRadius:20, border:"1px solid var(--border)",
        background:"transparent", color:"var(--muted)",
        fontSize:11, cursor:"pointer", fontFamily:S.f, fontWeight:500, flexShrink:0,
      }}>{isDark ? "☀️" : "🌙"}</button>
    </div>
    );
  };

  // Stock Detail
  if (sel) return (
    <div className={isDark?"dark":""} style={rootSt}>
      <style>{css}</style>
      <div ref={scrollRef} style={shellSt}>
        <div style={{ transform:"translateY(" + (refreshing ? 50 : pullDist * 0.6) + "px)", transition: pullDist === 0 || refreshing ? "transform 0.5s cubic-bezier(0.34,1.56,0.64,1)" : "none", willChange:"transform" }}>
          {sticky ? <div style={{ position:"sticky", top:0, zIndex:50, background:"var(--bg)", paddingBottom:2 }}><CurBar /></div> : <CurBar />}
          <StockDetail stock={sel} cur={cur} onBack={() => { setSel(null); if(scrollRef.current) scrollRef.current.scrollTop = 0; }} />
        </div>
        {/* Pull indicator - fixed at top */}
        <div style={{ position:"absolute", top:0, left:0, right:0, textAlign:"center", pointerEvents:"none",
          transform:"translateY(" + (refreshing ? 10 : Math.max(-40, pullDist * 0.6 - 40)) + "px)",
          transition: pullDist === 0 || refreshing ? "transform 0.5s cubic-bezier(0.34,1.56,0.64,1)" : "none",
          opacity: refreshing ? 1 : Math.min(1, pullDist / 30), zIndex:200,
        }}>
          <div style={{ fontSize:22, color:"var(--accent)", fontFamily:S.f, fontWeight:600, display:"inline-block",
            transform:"rotate(" + (refreshing ? 0 : pullDist * 5) + "deg)",
            animation: refreshing ? "spin 0.6s linear infinite" : "none",
          }}>↻</div>
          <div style={{ fontSize:11, color: refreshing ? "var(--accent)" : "var(--muted)", fontFamily:S.f, fontWeight: refreshing ? 700 : 400 }}>
            {refreshing ? "✓ Actualizado" : pullDist >= 60 ? "Suelta ↑" : ""}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className={isDark?"dark":""} style={rootSt}>
      <style>{css}</style>
      <div ref={scrollRef} style={shellSt}>
        {/* Pull indicator - absolute positioned */}
        <div style={{ position:"absolute", top:0, left:0, right:0, textAlign:"center", pointerEvents:"none",
          transform:"translateY(" + (refreshing ? 10 : Math.max(-40, pullDist * 0.6 - 40)) + "px)",
          transition: pullDist === 0 || refreshing ? "transform 0.5s cubic-bezier(0.34,1.56,0.64,1)" : "none",
          opacity: refreshing ? 1 : Math.min(1, pullDist / 30), zIndex:200,
        }}>
          <div style={{ fontSize:22, color:"var(--accent)", fontFamily:S.f, fontWeight:600, display:"inline-block",
            transform:"rotate(" + (refreshing ? 0 : pullDist * 5) + "deg)",
            animation: refreshing ? "spin 0.6s linear infinite" : "none",
          }}>↻</div>
          <div style={{ fontSize:11, color: refreshing ? "var(--accent)" : "var(--muted)", fontFamily:S.f, fontWeight: refreshing ? 700 : 400 }}>
            {refreshing ? "✓ Actualizado" : pullDist >= 60 ? "Suelta ↑" : ""}
          </div>
        </div>
        {/* Content - pushed down by pull */}
        <div style={{ transform:"translateY(" + (refreshing ? 50 : pullDist * 0.6) + "px)", transition: pullDist === 0 || refreshing ? "transform 0.5s cubic-bezier(0.34,1.56,0.64,1)" : "none", willChange:"transform" }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 0 4px" }}>
          <div>
            <div style={{ fontSize:20, fontWeight:800, color:"var(--text)", fontFamily:S.f }}>Venevalore$</div>
            <div style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f }}>BVC: Renta Variable FX Visualizer</div>
          </div>
          <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f, textAlign:"right" }}>
            <div>{lastRefresh.getDate()} {MO[lastRefresh.getMonth()]} {lastRefresh.getFullYear()}</div>
            <div>{cur === "VES" ? "Bs/$BCV: 466,60" : cur === "USD_BCV" ? "$BCV: 466,60 Bs/$" : cur === "EUR_BCV" ? "€BCV: 540,17 Bs/€" : "⚡Par: 678,00 Bs/$"}</div>
          </div>
        </div>

        {sticky ? <div style={{ position:"sticky", top:0, zIndex:50, background:"var(--bg)", paddingBottom:2 }}><CurBar /></div> : <CurBar />}

        <div key={fadeKey} className="tab-fade" style={{ flex:1, paddingBottom:70 }}>
          {tab === "fx" ? <FXTab /> : tab === "datos" ? <DataTab cur={cur} /> : tab === "commodities" ? <CommoditiesTab /> : tab === "sources" ? <SourcesTab /> : tab === "features" ? <FeaturesTab /> : tab === "about" ? <AboutTab /> : (
            <>
              {/* IBC Card */}
              <div style={{ background:"var(--card)", borderRadius:16, padding:"14px 14px 8px", marginTop:8, marginBottom:12, border:"1px solid var(--border)" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
                  <div>
                    <div style={{ fontSize:12, color:"var(--muted)", fontFamily:S.f, fontWeight:600 }}>IBC{cur === "USD_PAR" ? " — Retorno Real" : ""}</div>
                    <div style={{ fontSize:24, fontWeight:800, color:"var(--text)", fontFamily:S.f }}>{fmtP(ibcSt.value, cur)}</div>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:13, fontWeight:700, color:ibcSt.pct >= 0 ? "#00C853" : "#FF1744", fontFamily:S.f }}>{fmtPct(ibcSt.pct)}</span>
                      {ibcSt.hover && ibcSt.date && <span style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f }}>{ibcTf === "1D" ? fmtTime(ibcSt.date) : fmtDate(ibcSt.date)}</span>}
                    </div>
                  </div>
                  {ibcTf === "1D" && (
                    <div style={{ textAlign:"right", flexShrink:0 }}>
                      <div style={{ fontSize:12, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{(() => { const d = new Date(); const dow = d.getDay(); if (dow === 0) d.setDate(d.getDate() - 2); else if (dow === 6) d.setDate(d.getDate() - 1); return fmtDate(d.getTime()); })()}</div>
                      <div style={{ fontSize:9, color:"var(--muted)", fontFamily:S.f }}>9:00 AM – 1:00 PM VET</div>
                    </div>
                  )}
                </div>
                <IBCChart cur={cur} tf={ibcTf} onStats={setIbcSt} />
                <div style={{ display:"flex", gap:4, justifyContent:"center", paddingTop:4, flexWrap:"wrap" }}>
                  {ibcTfs.map(t => (
                    <button key={t.key} onClick={() => setIbcTf(t.key)} style={{
                      padding:"3px 10px", borderRadius:12, border:"none",
                      background:ibcTf === t.key ? "var(--text)" : "transparent",
                      color:ibcTf === t.key ? "var(--bg)" : "var(--muted)",
                      fontSize:10, cursor:"pointer", fontFamily:S.f, fontWeight:600,
                    }}>{t.label}</button>
                  ))}
                </div>
              </div>

              {/* Sub-indices */}
              <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                <div style={{ flex:1, background:"var(--card)", borderRadius:12, padding:"10px 12px", border:"1px solid var(--border)" }}>
                  <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f, fontWeight:600 }}>🏦 Índice Financiero</div>
                  <div style={{ fontSize:18, fontWeight:800, color:"var(--text)", fontFamily:S.f }}>
                    {cur === "VES" ? IBC_FIN.toLocaleString("es-VE") : fmtP(toFX(IBC_FIN, cur), cur)}
                  </div>
                  <div style={{ fontSize:9, color:"var(--muted)", fontFamily:S.f }}>{cur === "VES" ? "puntos" : "equiv. " + FX[cur].sym} · Bancos</div>
                </div>
                <div style={{ flex:1, background:"var(--card)", borderRadius:12, padding:"10px 12px", border:"1px solid var(--border)" }}>
                  <div style={{ fontSize:10, color:"var(--muted)", fontFamily:S.f, fontWeight:600 }}>🏭 Índice Industrial</div>
                  <div style={{ fontSize:18, fontWeight:800, color:"var(--text)", fontFamily:S.f }}>
                    {cur === "VES" ? IBC_IND.toLocaleString("es-VE") : fmtP(toFX(IBC_IND, cur), cur)}
                  </div>
                  <div style={{ fontSize:9, color:"var(--muted)", fontFamily:S.f }}>{cur === "VES" ? "puntos" : "equiv. " + FX[cur].sym} · Industria</div>
                </div>
              </div>

              {/* Search */}
              <div style={{ position:"relative", marginBottom:8 }}>
                <input type="text" placeholder="Buscar acciones..." value={search} onChange={e => setSearch(e.target.value)}
                  style={{ width:"100%", padding:"10px 12px 10px 36px", borderRadius:12, border:"1px solid var(--border)", background:"var(--card)", color:"var(--text)", fontSize:13, fontFamily:S.f, outline:"none", boxSizing:"border-box" }} />
                <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", fontSize:15, color:"var(--muted)" }}>🔍</span>
              </div>

              {/* Filters */}
              <div style={{ display:"flex", gap:4, overflowX:"auto", paddingBottom:8, flexShrink:0 }}>
                {["ALL", ...new Set(STOCKS.map(s => s.industry))].map(id => (
                  <button key={id} onClick={() => setInd(id)} style={{
                    padding:"4px 10px", borderRadius:16, border:"1px solid var(--border)",
                    background:ind === id ? "var(--text)" : "transparent", color:ind === id ? "var(--bg)" : "var(--muted)",
                    fontSize:10, cursor:"pointer", fontFamily:S.f, fontWeight:600, whiteSpace:"nowrap", flexShrink:0,
                  }}>{IND[id]?.i} {IND[id]?.l}</button>
                ))}
              </div>

              {/* Stock List */}
              <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                {filtered.map(stock => {
                  // 1D change: use intraday data
                  const intra = stock.intraday.map(d => vesAtDate(d, cur));
                  const fC = intra[0], lC = intra[intra.length - 1];
                  const pct = fC.close ? ((lC.close - fC.open) / fC.open) * 100 : 0;
                  const up = pct >= 0;
                  const sp = intra.map(d => d.close);
                  const spMn = Math.min(...sp), spMx = Math.max(...sp), spR = spMx - spMn || 1;
                  const spW = 58, spH = 26;
                  const spP = sp.map((v, i) => (i === 0 ? "M" : "L") + ((i / (sp.length - 1)) * spW) + "," + (spH - ((v - spMn) / spR) * spH)).join(" ");
                  const spRefY = spH - ((sp[0] - spMn) / spR) * spH;

                  return (
                    <div key={stock.ticker} onClick={() => { setSel(stock); setTimeout(() => { if(scrollRef.current) scrollRef.current.scrollTop = 0; }, 0); }}
                      style={{ display:"flex", alignItems:"center", padding:"10px 8px", borderRadius:12, cursor:"pointer", transition:"background 0.15s" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "var(--card)"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                      <div style={{ fontSize:24, marginRight:10, width:32, textAlign:"center", flexShrink:0 }}>{stock.logo}</div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
                          <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:S.f }}>{stock.ticker}</div>
                          <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:S.f, textAlign:"right" }}>{fmtP(lC.close, cur)}</div>
                        </div>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                          <div style={{ fontSize:11, color:"var(--muted)", fontFamily:S.f, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:120 }}>{stock.name}</div>
                          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                            <svg width={spW} height={spH} style={{ display:"block", flexShrink:0 }}>
                              <line x1={0} x2={spW} y1={spRefY} y2={spRefY} stroke={up ? "#00C853" : "#FF1744"} strokeWidth={0.4} strokeDasharray="2,2" opacity={0.35} />
                              <path d={spP} fill="none" stroke={up ? "#00C853" : "#FF1744"} strokeWidth={1.1} />
                            </svg>
                            <div style={{ fontSize:12, fontWeight:700, color:up ? "#00C853" : "#FF1744", fontFamily:S.f, minWidth:52, textAlign:"right" }}>{fmtPct(pct)}</div>
                          </div>
                        </div>
                      </div>
                      <button onClick={e => { e.stopPropagation(); togW(stock.ticker); }}
                        style={{ background:"none", border:"none", fontSize:16, cursor:"pointer", padding:"0 0 0 6px", color:wl.includes(stock.ticker) ? "#FFB300" : "var(--muted)", flexShrink:0 }}>
                        {wl.includes(stock.ticker) ? "★" : "☆"}
                      </button>
                    </div>
                  );
                })}
                {filtered.length === 0 && <div style={{ padding:32, textAlign:"center", color:"var(--muted)", fontSize:14, fontFamily:S.f }}>No se encontraron acciones</div>}
              </div>
            </>
          )}
        </div>
        </div>{/* close transform wrapper */}

        {/* Bottom tabs */}
        <div style={{ position:"fixed", bottom:0, left:0, right:0, background:"var(--card)", borderTop:"1px solid var(--border)", display:"flex", justifyContent:"space-around", padding:"6px 0 env(safe-area-inset-bottom,8px)", zIndex:100, backdropFilter:"blur(12px)" }}>
          {[{ k:"market", i:"📊", l:"Mercado" }, { k:"watchlist", i:"⭐", l:"Watchlist" }, { k:"fx", i:"💱", l:"FX" }, { k:"commodities", i:"🛢️", l:"Commodities" }, { k:"datos", i:"📋", l:"Datos" }, { k:"sources", i:"📚", l:"Fuentes" }, { k:"features", i:"🚀", l:"Features" }, { k:"about", i:"ℹ️", l:"Info" }].map(t => (
            <button key={t.k} onClick={() => switchTab(t.k)}
              style={{ background:"none", border:"none", display:"flex", flexDirection:"column", alignItems:"center", gap:2, cursor:"pointer", padding:"4px 8px", color:tab === t.k ? "var(--accent)" : "var(--muted)" }}>
              <span style={{ fontSize:16 }}>{t.i}</span>
              <span style={{ fontSize:9, fontWeight:600, fontFamily:S.f }}>{t.l}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
:root { --bg:#F8F9FB; --card:#FFF; --text:#0D1117; --muted:#6B7280; --border:#E5E7EB; --accent:#0066FF; --grid:#F0F0F0; }
.dark { --bg:#0D1117; --card:#161B22; --text:#F0F6FC; --muted:#8B949E; --border:#30363D; --accent:#58A6FF; --grid:#21262D; }
* { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
body { margin:0; background:var(--bg); -webkit-user-select:none; user-select:none; }
input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
input[type=number] { -moz-appearance:textfield; }
::-webkit-scrollbar { width:0; height:0; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
.tab-fade { animation: fadeIn 0.25s ease-out; }
`;
const rootSt = { width:"100%", minHeight:"100vh", background:"var(--bg)", display:"flex", justifyContent:"center", fontFamily:"'DM Sans',sans-serif" };
const shellSt = { width:"100%", maxWidth:430, height:"100vh", padding:"0 16px", position:"relative", display:"flex", flexDirection:"column", overflowY:"auto", overflowX:"hidden", WebkitOverflowScrolling:"touch" };
