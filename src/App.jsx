import { useState, useEffect, useMemo, useCallback, useRef } from "react";

/* ═══ Seeded PRNG ═══ */
function mulberry32(s){return function(){s|=0;s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function hashStr(s){let h=0;for(let i=0;i<s.length;i++)h=Math.imul(31,h)+s.charCodeAt(i)|0;return Math.abs(h);}

/* ═══ FX Rates (today's spot) — order: VES, $BCV, €BCV, ⚡Paralelo ═══ */
const FX={
  VES:{label:"Bolívares (VES)",sym:"Bs",rate:1,flag:"🇻🇪"},
  USD_BCV:{label:"Dólar BCV",sym:"$",rate:462.67,flag:"🇺🇸"},
  EUR_BCV:{label:"Euro BCV",sym:"€",rate:536.09,flag:"🇪🇺"},
  USD_PAR:{label:"Dólar Paralelo",sym:"$",rate:678,flag:"⚡"},
};
function toFX(v,c){return c==="VES"?v:v/FX[c].rate;}
function fmtP(v,c){const s=FX[c].sym;if(Math.abs(v)>=1e3)return`${s}${v.toLocaleString("es-VE",{minimumFractionDigits:2,maximumFractionDigits:2})}`;if(Math.abs(v)>=0.1)return`${s}${v.toFixed(2)}`;if(Math.abs(v)>=0.001)return`${s}${v.toFixed(4)}`;return`${s}${v.toFixed(6)}`;}
function fmtPct(v){return`${v>=0?"+":""}${v.toFixed(2)}%`;}
const MO=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDate(ts){const d=new Date(ts);return`${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}`;}
function fmtTime(ts){const d=new Date(ts);return`${d.getHours()%12||12}:${String(d.getMinutes()).padStart(2,"0")} ${d.getHours()>=12?"PM":"AM"}`;}
function fmtVES(v){if(v>=1e12)return`${(v/1e12).toFixed(1)}T`;if(v>=1e9)return`${(v/1e9).toFixed(1)}B`;if(v>=1e6)return`${(v/1e6).toFixed(1)}M`;if(v>=1e3)return`${(v/1e3).toFixed(1)}K`;return v.toFixed(0);}
function fmtMcap(ves,c){return`${FX[c].sym}${fmtVES(toFX(ves,c))}`;}

const IND={ALL:{l:"Todas",i:"📊"},FIN:{l:"Finanzas",i:"🏦"},CON:{l:"Consumo",i:"🛒"},MFG:{l:"Industrial",i:"🏭"},AGR:{l:"Agro",i:"🌾"},TEL:{l:"Telecom",i:"📡"},REA:{l:"Inmobiliario",i:"🏢"}};

/* ═══ FX History — controlled start→end with noise ═══ */
function genFXHist(startRate, endRate, totalDays, vol, seed) {
  const rng = mulberry32(seed);
  const now = Date.now();
  const dates = [];
  for (let i = totalDays; i >= 0; i--) {
    const ts = now - i * 86400000;
    if (new Date(ts).getDay() % 6 !== 0) dates.push(ts);
  }
  const N = dates.length;
  const logS = Math.log(startRate), logE = Math.log(endRate);
  let noise = 0;
  return dates.map((date, i) => {
    const t = i / (N - 1 || 1);
    noise += (rng() - 0.5) * vol;
    noise *= 0.995;
    return { date, rate: Math.max(1, Math.exp(logS + (logE - logS) * t + noise)) };
  });
}

/* ═══ Stock daily OHLC — backward walk ═══ */
function genDaily(basePrice, totalDays, vol, trend, seed) {
  const rng = mulberry32(seed);
  const now = Date.now();
  const dates = [];
  for (let i = totalDays; i >= 0; i--) { const ts = now - i*86400000; if (new Date(ts).getDay()%6!==0) dates.push(ts); }
  const closes = new Array(dates.length);
  closes[dates.length - 1] = basePrice;
  for (let i = dates.length - 2; i >= 0; i--) {
    closes[i] = closes[i+1] / (1 + (rng()-0.5)*vol + trend);
    if (closes[i] <= 0) closes[i] = closes[i+1] * 0.95;
  }
  return dates.map((date, i) => {
    const close = closes[i], prev = i > 0 ? closes[i-1] : close;
    const open = prev, w = rng()*vol*0.35;
    return { date, open, high: Math.max(open,close)*(1+w), low: Math.min(open,close)*(1-rng()*vol*0.35), close, volume: Math.floor(rng()*1e6+5e4) };
  });
}

function genIntraday(basePrice, seed) {
  const rng = mulberry32(seed + 7777);
  let target = new Date(); target.setHours(0,0,0,0);
  const dow = target.getDay();
  if (dow === 0) target.setDate(target.getDate()-2);
  else if (dow === 6) target.setDate(target.getDate()-1);
  const openMs = target.getTime() + (9*60+30)*60000;
  const N = 14, closes = new Array(N); closes[N-1] = basePrice;
  for (let i = N-2; i >= 0; i--) closes[i] = closes[i+1] / (1 + (rng()-0.5)*0.004);
  return Array.from({length:N}, (_,i) => {
    const date = openMs+i*15*60000, close = closes[i];
    const open = i>0?closes[i-1]:close*(1+(rng()-0.5)*0.002);
    return { date, open, high:Math.max(open,close)*(1+rng()*0.001), low:Math.min(open,close)*(1-rng()*0.001), close, volume:Math.floor(rng()*2e5+1e4) };
  });
}

/* ═══ FX Histories — calibrated ═══ */
const MAX_DAYS = 1825;
const FX_HIST = {
  USD_BCV: genFXHist(80, 462.67, 1095, 0.03, 201),
  EUR_BCV: genFXHist(95, 536.09, 1095, 0.03, 203),
  USD_PAR: genFXHist(120, 678, 730, 0.06, 202),
};
const FX_MAX_DAYS = { VES: 99999, USD_BCV: 1095, EUR_BCV: 1095, USD_PAR: 730 };

function fxAtDate(cur, ts) {
  if (cur === "VES") return 1;
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
  return {...ohlc, open:ohlc.open*r, high:ohlc.high*r, low:ohlc.low*r, close:ohlc.close*r};
}

/* ═══ Stocks ═══ */
const SR = [
  {t:"RST",n:"Ron Santa Teresa",p:570.99,ind:"CON",logo:"🥃",ipo:1990,mc:326e9,vw:1.3e9,pe:"12.3",ibc:true,desc:"Productor icónico de ron venezolano. Fundada 1796, acción más negociada del BVC.",tr:0.005},
  {t:"RST.B",n:"Ron Santa Teresa (B)",p:548.50,ind:"CON",logo:"🥃",ipo:2025,mc:326e9,vw:180e6,pe:"12.3",ibc:true,desc:"Clase B. Añadida al IBC mar 2026.",tr:0.004},
  {t:"MVZ.A",n:"Mercantil Serv. Fin. (A)",p:8200,ind:"FIN",logo:"🏛️",ipo:1997,mc:761e9,vw:95e6,pe:"8.5",ibc:true,desc:"Mayor grupo financiero privado. ~3,110 empleados.",tr:0.004},
  {t:"MVZ.B",n:"Mercantil Serv. Fin. (B)",p:7800,ind:"FIN",logo:"🏛️",ipo:1997,mc:761e9,vw:72e6,pe:"8.5",ibc:true,desc:"Clase B de Mercantil.",tr:0.0038},
  {t:"BVL",n:"Banco de Venezuela",p:193.00,ind:"FIN",logo:"🏦",ipo:2014,mc:704e9,vw:45e6,pe:"5.2",ibc:true,desc:"Banco más grande (~35.5% depósitos). Estatal, 1890.",tr:0.003},
  {t:"BPV",n:"Banco Provincial (BBVA)",p:152.00,ind:"FIN",logo:"🅱️",ipo:1983,mc:676e9,vw:148e6,pe:"1.06",ibc:true,desc:"Subsidiaria BBVA. ~1,870 empleados.",tr:0.0042},
  {t:"BNC",n:"Banco Nacional de Crédito",p:1872.00,ind:"FIN",logo:"💳",ipo:2006,mc:464e9,vw:210e6,pe:"51",ibc:true,desc:"Banco universal, muy activo en BVC.",tr:0.0045},
  {t:"ABC.A",n:"Banco del Caribe (A)",p:2320.00,ind:"FIN",logo:"🌊",ipo:1988,mc:311e9,vw:38e6,pe:"7.8",ibc:true,desc:"Banco regional caribeño.",tr:0.003},
  {t:"BVCC",n:"Bolsa de Valores de Caracas",p:74.00,ind:"FIN",logo:"📈",ipo:1990,mc:1.56e9,vw:28.5e6,pe:"15.4",ibc:true,desc:"La bolsa de Venezuela, 1947.",tr:0.0048},
  {t:"CGQ",n:"Corp. Grupo Químico",p:1800.00,ind:"MFG",logo:"🧪",ipo:1995,mc:164e9,vw:22e6,pe:"9.2",ibc:false,desc:"Conglomerado químico.",tr:0.0028},
  {t:"FNC",n:"Fáb. Nac. de Cementos",p:1990.00,ind:"MFG",logo:"🏗️",ipo:1985,mc:161e9,vw:18e6,pe:"11.5",ibc:false,desc:"Principal cementera.",tr:0.0035},
  {t:"ENV",n:"Envases Venezolanos",p:925.00,ind:"MFG",logo:"📦",ipo:1992,mc:124e9,vw:35e6,pe:"6.8",ibc:true,desc:"Líder en empaques.",tr:0.004},
  {t:"PGR",n:"Proagro C.A.",p:113.00,ind:"AGR",logo:"🐔",ipo:1998,mc:83e9,vw:15e6,pe:"4.5",ibc:false,desc:"Cadena avícola.",tr:0.0025},
  {t:"EFE",n:"Productos EFE",p:112.49,ind:"CON",logo:"🍦",ipo:1990,mc:79e9,vw:12e6,pe:"7.1",ibc:false,desc:"Helados desde 1926.",tr:0.0032},
  {t:"TDV.D",n:"CANTV (Clase D)",p:86.00,ind:"TEL",logo:"📡",ipo:1996,mc:67e9,vw:23e6,pe:"N/A",ibc:true,desc:"Telecom estatal.",tr:0.002},
  {t:"GZL",n:"Grupo Zuliano",p:950.00,ind:"MFG",logo:"🏭",ipo:2000,mc:46e9,vw:100e6,pe:"8.3",ibc:false,desc:"Grupo industrial, Zulia.",tr:0.0038},
  {t:"DOM",n:"Domínguez & Cía.",p:750.00,ind:"MFG",logo:"⚙️",ipo:1990,mc:38e9,vw:16e6,pe:"5.6",ibc:true,desc:"Manufactura diversificada.",tr:0.003},
  {t:"MPA",n:"MANPA",p:100.50,ind:"MFG",logo:"📄",ipo:1985,mc:23e9,vw:8e6,pe:"3.9",ibc:true,desc:"Papel y pulpa.",tr:0.0022},
  {t:"CCR",n:"Cerámica Carabobo",p:7090.00,ind:"MFG",logo:"🏺",ipo:1992,mc:20e9,vw:5e6,pe:"10.2",ibc:false,desc:"Baldosas cerámicas.",tr:0.0035},
  {t:"CRM.A",n:"Corimon C.A.",p:668.00,ind:"MFG",logo:"🎨",ipo:1990,mc:535e6,vw:14e6,pe:"4.2",ibc:true,desc:"Pinturas Montana.",tr:0.0026},
  {t:"PTN",n:"Protinal C.A.",p:63.70,ind:"AGR",logo:"🌽",ipo:1995,mc:9.6e9,vw:4e6,pe:"N/A",ibc:false,desc:"Avícola y alimentos.",tr:0.0018},
  {t:"SVS",n:"Sivensa",p:173.50,ind:"MFG",logo:"⚒️",ipo:1988,mc:9.1e9,vw:7e6,pe:"N/A",ibc:true,desc:"Acero y metalurgia.",tr:0.0044},
  {t:"2TPG",n:"Telares de Palo Grande",p:1.25,ind:"MFG",logo:"🧵",ipo:1990,mc:1.5e9,vw:2e6,pe:"N/A",ibc:false,desc:"Manufactura textil.",tr:0.0015},
  {t:"FNV",n:"Fáb. Nac. de Vidrio",p:0.51,ind:"MFG",logo:"🪟",ipo:1990,mc:28e6,vw:800e3,pe:"N/A",ibc:false,desc:"Fábrica de vidrio.",tr:0.003},
  {t:"2CIE",n:"Corp. Ind. de Energía",p:0.14,ind:"TEL",logo:"⚡",ipo:2005,mc:68e6,vw:300e3,pe:"N/A",ibc:false,desc:"Energía industrial.",tr:0.0012},
  {t:"IVC",n:"INVACA",p:50.01,ind:"REA",logo:"🏢",ipo:1992,mc:3.5e9,vw:1.2e6,pe:"N/A",ibc:false,desc:"Inmobiliaria Caracas.",tr:0.0028},
  {t:"PIV.A",n:"PIVCA (A)",p:185.00,ind:"FIN",logo:"💎",ipo:2022,mc:12e9,vw:6e6,pe:"N/A",ibc:false,desc:"Promotora de Inversiones.",tr:0.0036},
  {t:"PIV.B",n:"PIVCA (B)",p:178.00,ind:"FIN",logo:"💎",ipo:2022,mc:12e9,vw:9e6,pe:"N/A",ibc:true,desc:"Clase B. IBC.",tr:0.0034},
  {t:"ALZ.B",n:"Alalza Inversiones (B)",p:95.00,ind:"FIN",logo:"📊",ipo:2022,mc:4e9,vw:3e6,pe:"N/A",ibc:false,desc:"Fondo BVC Alternativo.",tr:0.0025},
  {t:"ARC.A",n:"Arca Inmuebles (A)",p:120.00,ind:"REA",logo:"🏠",ipo:2023,mc:6e9,vw:4e6,pe:"N/A",ibc:false,desc:"Fondo inmobiliario.",tr:0.004},
  {t:"ARC.B",n:"Arca Inmuebles (B)",p:115.50,ind:"REA",logo:"🏠",ipo:2023,mc:6e9,vw:5.5e6,pe:"N/A",ibc:false,desc:"Clase B Arca.",tr:0.0038},
  {t:"CCP.B",n:"Clabe Capital (B)",p:210.00,ind:"FIN",logo:"🪙",ipo:2023,mc:8e9,vw:7e6,pe:"N/A",ibc:false,desc:"Fondo alternativo.",tr:0.0042},
  {t:"FFV.B",n:"Fivenca Fondo (B)",p:145.00,ind:"FIN",logo:"💰",ipo:2023,mc:5e9,vw:3.5e6,pe:"N/A",ibc:false,desc:"Capital privado.",tr:0.003},
  {t:"FPB.B",n:"Fondo Petrolia (B)",p:88.00,ind:"TEL",logo:"🛢️",ipo:2023,mc:3e9,vw:2e6,pe:"N/A",ibc:false,desc:"Sector petrolero.",tr:0.0035},
  {t:"ICP.B",n:"Crecepymes (B)",p:72.00,ind:"FIN",logo:"🌱",ipo:2024,mc:2.5e9,vw:4e6,pe:"N/A",ibc:false,desc:"PyMEs.",tr:0.0038},
  {t:"IMP.B",n:"Impulsa Agronegocios (B)",p:55.00,ind:"AGR",logo:"🌿",ipo:2024,mc:1.8e9,vw:3e6,pe:"N/A",ibc:false,desc:"Capital agrícola.",tr:0.003},
  {t:"MNT.B",n:"Montesco Agroind. (B)",p:63.00,ind:"AGR",logo:"🌾",ipo:2024,mc:2e9,vw:2.5e6,pe:"N/A",ibc:false,desc:"Agroindustrial.",tr:0.0022},
  {t:"VNA.B",n:"Venealternative (B)",p:98.00,ind:"FIN",logo:"🌐",ipo:2023,mc:3.2e9,vw:1.8e6,pe:"N/A",ibc:false,desc:"Exportaciones.",tr:0.0032},
  {t:"INV",n:"Inverdica",p:0.01,ind:"FIN",logo:"📉",ipo:1995,mc:8e3,vw:0,pe:"N/A",ibc:false,desc:"Holding inactiva.",tr:0.0005},
];

const IBC_VES=6472.57,IBC_FIN=12778.02,IBC_IND=2712.46;
const IBC_DAILY=genDaily(IBC_VES,MAX_DAYS,0.02,0.004,999);
const IBC_INTRA=genIntraday(IBC_VES,999);
const STOCKS=SR.map(s=>{const d=Math.min(MAX_DAYS,Math.max(30,Math.floor((2026-s.ipo)*365.25))),seed=hashStr(s.t);return{ticker:s.t,name:s.n,price:s.p,industry:s.ind,logo:s.logo,ipo:s.ipo,mcapVES:s.mc,volW:s.vw,pe:s.pe,ibc:s.ibc,desc:s.desc,daily:genDaily(s.p,d,s.p>100?0.025:0.04,s.tr,seed),intraday:genIntraday(s.p,seed)};});

/* ═══ Timeframes ═══ */
const TFS=[{key:"1D",label:"1D",days:0},{key:"1W",label:"1S",days:7},{key:"1M",label:"1M",days:30},{key:"3M",label:"3M",days:90},{key:"6M",label:"6M",days:180},{key:"1Y",label:"1A",days:365},{key:"5Y",label:"5A",days:1825}];
function sliceData(daily,intraday,tf,cur){if(tf==="1D")return intraday;let days=TFS.find(t=>t.key===tf)?.days||90;const mx=FX_MAX_DAYS[cur]||99999;if(days>mx)days=mx;return daily.slice(Math.max(0,daily.length-days-1));}

/* ═══ Chart ═══ */
const VBW=420;
function Chart({data,cur,type,height=260,onHover,is1D=false}){
  const ref=useRef(null),[tip,setTip]=useState(null),vH=height;
  const conv=useMemo(()=>data.map(d=>vesAtDate(d,cur)),[data,cur]);
  const pad={t:20,r:12,b:24,l:58},W=VBW-pad.l-pad.r,H=vH-pad.t-pad.b;
  const prices=conv.flatMap(d=>[d.high,d.low]),mn=Math.min(...prices),mx=Math.max(...prices),rng=mx-mn||1;
  const yMn=mn-rng*0.05,yMx=mx+rng*0.05;
  const xS=i=>pad.l+(i/(conv.length-1||1))*W,yS=p=>pad.t+(1-(p-yMn)/(yMx-yMn))*H;
  const first=conv[0]?.close||0,last=conv[conv.length-1]?.close||0;
  const up=last>=first,col=up?"#00C853":"#FF1744",gid=`g${hashStr(cur+type+data.length)}`;

  const onMouse=useCallback(e=>{if(!ref.current)return;const rc=ref.current.getBoundingClientRect();if(rc.width<=0)return;const vbX=(e.clientX-rc.left)*(VBW/rc.width),ratio=Math.max(0,Math.min(1,(vbX-pad.l)/W)),idx=Math.round(ratio*(conv.length-1));if(idx>=0&&idx<conv.length){setTip({x:xS(idx),y:yS(conv[idx].close),d:conv[idx]});if(onHover)onHover(data[idx]);}},[conv,data,W,onHover]);
  const onLeave=()=>{setTip(null);if(onHover)onHover(null);};
  const yTk=Array.from({length:5},(_,i)=>{const v=yMn+(i/4)*(yMx-yMn);return{v,y:yS(v)};});
  const tLbl=tip?(is1D?fmtTime(tip.d.date):fmtDate(tip.d.date)):"";
  const grid=yTk.map((t,i)=><g key={i}><line x1={pad.l} x2={pad.l+W} y1={t.y} y2={t.y} stroke="var(--grid)" strokeWidth={0.5}/><text x={pad.l-5} y={t.y+3} textAnchor="end" fill="var(--muted)" fontSize={9} fontFamily="'DM Sans'">{fmtP(t.v,cur)}</text></g>);
  const tipL=tip&&<><line x1={tip.x} x2={tip.x} y1={pad.t} y2={pad.t+H} stroke="var(--muted)" strokeWidth={0.4} strokeDasharray="3,3"/><circle cx={tip.x} cy={tip.y} r={3.5} fill={col} stroke="#fff" strokeWidth={1.2}/></>;
  const tipB=tip&&<foreignObject x={Math.min(tip.x+8,VBW-142)} y={Math.max(tip.y-68,2)} width={136} height={64}><div style={{background:"var(--card)",border:"1px solid var(--border)",borderRadius:7,padding:"4px 7px",fontSize:9.5,fontFamily:"'DM Sans'",color:"var(--text)",boxShadow:"0 3px 12px rgba(0,0,0,0.08)"}}><div style={{fontWeight:600,marginBottom:1}}>{tLbl}</div><div>O:{fmtP(tip.d.open,cur)} C:{fmtP(tip.d.close,cur)}</div><div>H:{fmtP(tip.d.high,cur)} L:{fmtP(tip.d.low,cur)}</div></div></foreignObject>;
  if(type==="candle"){const cw=Math.max(1.5,(W/conv.length)*0.55);return<svg ref={ref} width="100%" viewBox={`0 0 ${VBW} ${vH}`} style={{display:"block"}} onMouseMove={onMouse} onMouseLeave={onLeave} onTouchMove={onMouse} onTouchEnd={onLeave}>{grid}{conv.map((d,i)=>{const bu=d.close>=d.open,c=bu?"#00C853":"#FF1744",x=xS(i),bT=yS(Math.max(d.open,d.close)),bB=yS(Math.min(d.open,d.close));return<g key={i}><line x1={x} x2={x} y1={yS(d.high)} y2={yS(d.low)} stroke={c} strokeWidth={0.8}/><rect x={x-cw/2} y={bT} width={cw} height={Math.max(bB-bT,0.5)} fill={c} rx={0.5}/></g>;})}{tipL}{tipB}</svg>;}
  const lp=conv.map((d,i)=>`${i===0?"M":"L"}${xS(i)},${yS(d.close)}`).join(" ");
  const ap=`${lp} L${xS(conv.length-1)},${pad.t+H} L${xS(0)},${pad.t+H} Z`;
  return<svg ref={ref} width="100%" viewBox={`0 0 ${VBW} ${vH}`} style={{display:"block"}} onMouseMove={onMouse} onMouseLeave={onLeave} onTouchMove={onMouse} onTouchEnd={onLeave}><defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity={0.16}/><stop offset="100%" stopColor={col} stopOpacity={0.01}/></linearGradient></defs>{grid}<path d={ap} fill={`url(#${gid})`}/><path d={lp} fill="none" stroke={col} strokeWidth={1.8} strokeLinejoin="round"/>{tipL}{tipB}</svg>;
}

/* ═══ IBC Chart — historical FX per day ═══ */
function IBCChart({cur,tf,onStats}){
  const data=useMemo(()=>sliceData(IBC_DAILY,IBC_INTRA,tf,cur),[tf,cur]);
  const conv=useMemo(()=>data.map(d=>{const r=cur==="VES"?1:fxAtDate(cur,d.date);return{v:cur==="VES"?d.close:d.close/r,date:d.date};}),[data,cur]);
  useEffect(()=>{if(onStats&&conv.length>=2){const f=conv[0].v,l=conv[conv.length-1].v;onStats({value:l,pct:f?((l-f)/f)*100:0,date:null,hover:false});}},[conv,onStats]);
  const ref=useRef(null),[tip,setTip]=useState(null);
  const VW=340,VH=150,pad={t:10,r:8,b:16,l:52},W=VW-pad.l-pad.r,H=VH-pad.t-pad.b;
  const vals=conv.map(c=>c.v),mn=Math.min(...vals),mx=Math.max(...vals),rng=mx-mn||1;
  const xS=i=>pad.l+(i/(conv.length-1||1))*W,yS=v=>pad.t+(1-(v-(mn-rng*0.05))/(rng*1.1))*H;
  const up=vals[vals.length-1]>=vals[0],col=up?"#00C853":"#FF1744";
  const path=vals.map((v,i)=>`${i===0?"M":"L"}${xS(i)},${yS(v)}`).join(" ");
  const is1D=tf==="1D";
  const onMouse=e=>{if(!ref.current)return;const rc=ref.current.getBoundingClientRect();if(rc.width<=0)return;const vbX=(e.clientX-rc.left)*(VW/rc.width),ratio=Math.max(0,Math.min(1,(vbX-pad.l)/W)),idx=Math.round(ratio*(conv.length-1));if(idx>=0&&idx<conv.length){const v=conv[idx].v,f=conv[0].v;setTip({x:xS(idx),y:yS(v),v,date:conv[idx].date});if(onStats)onStats({value:v,pct:f?((v-f)/f)*100:0,date:conv[idx].date,hover:true});}};
  const onLeave=()=>{setTip(null);if(onStats&&conv.length>=2){const f=conv[0].v,l=conv[conv.length-1].v;onStats({value:l,pct:f?((l-f)/f)*100:0,date:null,hover:false});}};
  return<svg ref={ref} width="100%" viewBox={`0 0 ${VW} ${VH}`} style={{display:"block"}} onMouseMove={onMouse} onMouseLeave={onLeave}>
    <defs><linearGradient id="ibcG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity={0.14}/><stop offset="100%" stopColor={col} stopOpacity={0}/></linearGradient></defs>
    <path d={`${path} L${xS(conv.length-1)},${pad.t+H} L${xS(0)},${pad.t+H} Z`} fill="url(#ibcG)"/><path d={path} fill="none" stroke={col} strokeWidth={1.4}/>
    {tip&&<><line x1={tip.x} x2={tip.x} y1={pad.t} y2={pad.t+H} stroke="var(--muted)" strokeWidth={0.3} strokeDasharray="2,2"/><circle cx={tip.x} cy={tip.y} r={2.5} fill={col} stroke="#fff" strokeWidth={0.8}/><text x={tip.x} y={tip.y-14} textAnchor="middle" fill="var(--text)" fontSize={8.5} fontFamily="'DM Sans'" fontWeight={600}>{fmtP(tip.v,cur)}</text><text x={tip.x} y={tip.y-5} textAnchor="middle" fill="var(--muted)" fontSize={7} fontFamily="'DM Sans'">{tip.date?(is1D?fmtTime(tip.date):fmtDate(tip.date)):""}</text></>}
  </svg>;
}

/* ═══ Stock Detail ═══ */
function StockDetail({stock,cur,onBack}){
  const [tf,setTf]=useState("3M"),[ct,setCT]=useState("line"),[hov,setHov]=useState(null);
  const is1D=tf==="1D";
  const data=useMemo(()=>sliceData(stock.daily,stock.intraday,tf,cur),[stock,tf,cur]);
  const first=data[0],last=data[data.length-1],disp=hov||last;
  const dC=vesAtDate(disp,cur),fC=vesAtDate(first,cur);
  const pct=fC.open?((dC.close-fC.open)/fC.open)*100:0,green=pct>=0;
  const maxFxD=FX_MAX_DAYS[cur]||99999;
  const availTfs=TFS.filter(t=>t.days<=maxFxD||t.days===0);
  return<div style={{paddingBottom:80}}>
    <button onClick={onBack} style={{background:"none",border:"none",color:"var(--accent)",fontSize:15,fontFamily:"'DM Sans'",cursor:"pointer",padding:"8px 0"}}>← Volver</button>
    <div style={{display:"flex",alignItems:"center",gap:12,margin:"8px 0 4px"}}><div style={{fontSize:36,lineHeight:1}}>{stock.logo}</div><div><div style={{fontSize:20,fontWeight:700,color:"var(--text)",fontFamily:"'DM Sans'"}}>{stock.name}</div><div style={{fontSize:13,color:"var(--muted)",fontFamily:"'DM Sans'"}}>{stock.ticker} · {IND[stock.industry]?.l}</div></div></div>
    <div style={{margin:"12px 0 4px"}}><span style={{fontSize:28,fontWeight:700,color:"var(--text)",fontFamily:"'DM Sans'"}}>{fmtP(dC.close,cur)}</span><span style={{fontSize:15,fontWeight:600,color:green?"#00C853":"#FF1744",marginLeft:10,fontFamily:"'DM Sans'"}}>{fmtPct(pct)}</span>{cur==="USD_PAR"&&<span style={{fontSize:10,color:"#F59E0B",marginLeft:6,fontFamily:"'DM Sans'",fontWeight:700}}>RETORNO REAL</span>}</div>
    {hov&&<div style={{fontSize:11,color:"var(--muted)",fontFamily:"'DM Sans'",marginBottom:4}}>{is1D?fmtTime(hov.date):fmtDate(hov.date)} · O:{fmtP(dC.open,cur)} C:{fmtP(dC.close,cur)} H:{fmtP(dC.high,cur)} L:{fmtP(dC.low,cur)}</div>}
    <div style={{display:"flex",gap:6,margin:"8px 0"}}>{["line","candle"].map(t=><button key={t} onClick={()=>setCT(t)} style={{padding:"5px 14px",borderRadius:20,border:"1px solid var(--border)",background:ct===t?"var(--accent)":"var(--card)",color:ct===t?"#fff":"var(--text)",fontSize:12,cursor:"pointer",fontFamily:"'DM Sans'",fontWeight:600}}>{t==="line"?"Línea":"Velas"}</button>)}</div>
    <div style={{background:"var(--card)",borderRadius:16,padding:"12px 4px",marginBottom:12,border:"1px solid var(--border)"}}><Chart data={data} cur={cur} type={ct} height={280} onHover={setHov} is1D={is1D}/></div>
    {cur!=="VES"&&<div style={{fontSize:10,color:"var(--muted)",fontFamily:"'DM Sans'",marginBottom:8,textAlign:"center"}}>Datos FX: {cur==="USD_PAR"?"últimos 2 años":"últimos 3 años"}</div>}
    <div style={{display:"flex",gap:5,marginBottom:16,justifyContent:"center",flexWrap:"wrap"}}>{availTfs.map(t=><button key={t.key} onClick={()=>{setTf(t.key);setHov(null);}} style={{padding:"5px 12px",borderRadius:20,border:"1px solid var(--border)",background:tf===t.key?"var(--text)":"transparent",color:tf===t.key?"var(--bg)":"var(--muted)",fontSize:12,cursor:"pointer",fontFamily:"'DM Sans'",fontWeight:600}}>{t.label}</button>)}</div>
    <div style={{background:"var(--card)",borderRadius:16,padding:16,marginBottom:12,border:"1px solid var(--border)"}}><div style={{fontSize:15,fontWeight:700,marginBottom:10,color:"var(--text)",fontFamily:"'DM Sans'"}}>Estadísticas</div>
      {(()=>{const c=vesAtDate(last,cur);return[["Open",fmtP(c.open,cur)],["Close",fmtP(c.close,cur)],["High",fmtP(c.high,cur)],["Low",fmtP(c.low,cur)],["Cap. Mercado",fmtMcap(stock.mcapVES,cur)],["P/E",stock.pe],["Vol. Semanal",fmtMcap(stock.volW,cur)],["IPO",String(stock.ipo)],["IBC",stock.ibc?"✅":"❌"]];})().map(([l,v],i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:i<8?"1px solid var(--border)":"none"}}><span style={{fontSize:13,color:"var(--muted)",fontFamily:"'DM Sans'"}}>{l}</span><span style={{fontSize:13,fontWeight:600,color:"var(--text)",fontFamily:"'DM Sans'"}}>{v}</span></div>)}
    </div>
    <div style={{background:"var(--card)",borderRadius:16,padding:16,border:"1px solid var(--border)"}}><div style={{fontSize:15,fontWeight:700,marginBottom:8,color:"var(--text)",fontFamily:"'DM Sans'"}}>Sobre {stock.name}</div><p style={{fontSize:13,color:"var(--muted)",lineHeight:1.6,margin:0,fontFamily:"'DM Sans'"}}>{stock.desc}</p></div>
  </div>;
}

/* ═══ FX Tab ═══ */
function FXTab(){
  const [amt,setAmt]=useState("1000"),[from,setFrom]=useState("VES"),[to,setTo]=useState("USD_BCV");
  const fV=from==="VES"?1:FX[from].rate,tV=to==="VES"?1:FX[to].rate,result=(parseFloat(amt)||0)*fV/tV;
  const swap=()=>{setFrom(to);setTo(from);};const opts=Object.entries(FX);
  return<div style={{paddingBottom:80}}>
    <div style={{fontSize:22,fontWeight:700,color:"var(--text)",fontFamily:"'DM Sans'",marginBottom:16}}>Calculadora FX</div>
    <div style={{background:"var(--card)",borderRadius:16,padding:16,marginBottom:16,border:"1px solid var(--border)"}}>
      <div style={{fontSize:13,fontWeight:700,marginBottom:10,color:"var(--text)",fontFamily:"'DM Sans'"}}>Tasas Actuales</div>
      {[{l:"Dólar BCV",r:"462,67 Bs/$",f:"🇺🇸"},{l:"Euro BCV",r:"536,09 Bs/€",f:"🇪🇺"},{l:"Dólar Paralelo (P2P)",r:"678,00 Bs/$",f:"⚡",hl:true},{l:"Spread Par/BCV",r:"46,6%",f:"📊"}].map((r,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:i<3?"1px solid var(--border)":"none"}}><span style={{fontSize:13,color:"var(--muted)",fontFamily:"'DM Sans'"}}>{r.f} {r.l}</span><span style={{fontSize:14,fontWeight:700,color:r.hl?"#F59E0B":"var(--text)",fontFamily:"'DM Sans'"}}>{r.r}</span></div>)}
    </div>
    <div style={{background:"var(--card)",borderRadius:16,padding:16,border:"1px solid var(--border)",marginBottom:16}}>
      <div style={{marginBottom:12}}><label style={{fontSize:11,color:"var(--muted)",fontFamily:"'DM Sans'",display:"block",marginBottom:4}}>Monto</label><input type="number" value={amt} onChange={e=>setAmt(e.target.value)} style={{width:"100%",padding:"10px 12px",borderRadius:10,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--text)",fontSize:18,fontWeight:700,fontFamily:"'DM Sans'",outline:"none",boxSizing:"border-box"}}/></div>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        <div style={{flex:1}}><label style={{fontSize:11,color:"var(--muted)",fontFamily:"'DM Sans'",display:"block",marginBottom:4}}>De</label><select value={from} onChange={e=>setFrom(e.target.value)} style={{width:"100%",padding:"10px 8px",borderRadius:10,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--text)",fontSize:13,fontFamily:"'DM Sans'"}}>{opts.map(([k,v])=><option key={k} value={k}>{v.flag} {v.label}</option>)}</select></div>
        <button onClick={swap} style={{marginTop:16,background:"var(--accent)",border:"none",borderRadius:"50%",width:36,height:36,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:16,color:"#fff",flexShrink:0}}>⇄</button>
        <div style={{flex:1}}><label style={{fontSize:11,color:"var(--muted)",fontFamily:"'DM Sans'",display:"block",marginBottom:4}}>A</label><select value={to} onChange={e=>setTo(e.target.value)} style={{width:"100%",padding:"10px 8px",borderRadius:10,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--text)",fontSize:13,fontFamily:"'DM Sans'"}}>{opts.map(([k,v])=><option key={k} value={k}>{v.flag} {v.label}</option>)}</select></div>
      </div>
      <div style={{background:"var(--bg)",borderRadius:12,padding:16,textAlign:"center"}}><div style={{fontSize:12,color:"var(--muted)",fontFamily:"'DM Sans'",marginBottom:4}}>Resultado</div><div style={{fontSize:28,fontWeight:700,color:"var(--text)",fontFamily:"'DM Sans'"}}>{FX[to].sym}{result.toLocaleString("es-VE",{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div style={{fontSize:11,color:"var(--muted)",fontFamily:"'DM Sans'",marginTop:4}}>1 {FX[from].label} = {(fV/tV).toFixed(4)} {FX[to].label}</div></div>
    </div>
    <div style={{background:"var(--card)",borderRadius:16,padding:16,border:"1px solid var(--border)",marginBottom:16}}>
      <div style={{fontSize:13,fontWeight:700,marginBottom:8,color:"var(--text)",fontFamily:"'DM Sans'"}}>Histórico Dólar BCV (3 años)</div><FXMini data={FX_HIST.USD_BCV}/>
      <div style={{fontSize:13,fontWeight:700,margin:"16px 0 8px",color:"var(--text)",fontFamily:"'DM Sans'"}}>Histórico Euro BCV (3 años)</div><FXMini data={FX_HIST.EUR_BCV}/>
      <div style={{margin:"16px 0 8px"}}><span style={{fontSize:13,fontWeight:700,background:"linear-gradient(135deg,#F59E0B,#EF4444)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",fontFamily:"'DM Sans'"}}>⚡ Dólar Paralelo (2 años)</span></div><FXMini data={FX_HIST.USD_PAR} color="#F59E0B"/>
    </div>
    {/* Methodology */}
    <div style={{background:"var(--card)",borderRadius:16,padding:16,border:"1px solid var(--border)",marginBottom:16}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12,color:"var(--text)",fontFamily:"'DM Sans'"}}>📐 Metodología de Cálculo</div>
      {[{t:"VES (Bolívares)",b:"Precio nominal en bolívares. No ajusta por inflación ni depreciación cambiaria.",c:"var(--text)"},
        {t:"$ BCV (Dólar Oficial)",b:"Cada día: Precio VES ÷ tasa BCV de ese día. El retorno refleja cuántos dólares oficiales vale tu inversión, ajustado día a día por la devaluación oficial. Datos: 3 años.",c:"var(--text)"},
        {t:"€ BCV (Euro Oficial)",b:"Misma lógica: Precio VES ÷ tasa euro BCV del día. Datos: 3 años.",c:"var(--text)"},
        {t:"⚡ $ Paralelo = RETORNO REAL",b:"Precio VES ÷ tasa paralelo (Binance P2P) del mismo día. Esta es la métrica más importante: refleja el precio real al que puedes comprar dólares. El spread entre paralelo y BCV varía diariamente — cuando se amplía, el bolívar se deprecia más rápido de lo que el BCV reconoce. Datos: 2 años.",c:"#F59E0B"},
        {t:"¿Por qué el paralelo mide el retorno real?",b:"El bolívar pierde valor continuamente. Si compraste dólares en vez de acciones, ¿cuánto tendrías hoy? El paralelo responde esa pregunta. Divides el precio de la acción entre la tasa paralelo de cada día para ver cuántos dólares 'reales' vale tu posición. Si la acción sube más que lo que el paralelo sube (= más que la depreciación), tu retorno real es positivo. El mercado bursátil venezolano ha superado consistentemente la depreciación.",c:"var(--text)"},
        {t:"Cálculo día a día",b:"Cada punto del gráfico = Precio VES ÷ tasa FX de ESE DÍA. El % retorno = (último valor convertido - primer valor convertido) / primer valor × 100. Si no hay tasa para un día (fin de semana, feriado), se usa la del último día hábil anterior. Para períodos anteriores al inicio de datos FX, se usa la tasa más antigua disponible.",c:"var(--text)"},
      ].map((s,i)=><div key={i} style={{marginBottom:12}}><div style={{fontSize:12,fontWeight:700,color:s.c,fontFamily:"'DM Sans'",marginBottom:3}}>{s.t}</div><div style={{fontSize:11.5,color:"var(--muted)",fontFamily:"'DM Sans'",lineHeight:1.6}}>{s.b}</div></div>)}
    </div>
    <div style={{background:"var(--card)",borderRadius:16,padding:16,border:"1px solid var(--border)"}}>
      <div style={{fontSize:13,fontWeight:700,marginBottom:10,color:"var(--text)",fontFamily:"'DM Sans'"}}>📋 Fuentes</div>
      {[{n:"BCV",s:"bcv.org.ve",d:"Tasa oficial diaria. Fallback último día hábil."},{n:"Paralelo",s:"p2p.binance.com",d:"P2P USDT/VES. Tipo de cambio real."},{n:"BVC",s:"bolsadecaracas.com",d:"Precios de cierre oficiales."}].map((s,i)=><div key={i} style={{padding:"8px 0",borderBottom:i<2?"1px solid var(--border)":"none"}}><div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:12,fontWeight:700,color:"var(--text)",fontFamily:"'DM Sans'"}}>{s.n}</span><span style={{fontSize:10,color:"var(--accent)",fontFamily:"'DM Sans'",fontWeight:600}}>{s.s}</span></div><div style={{fontSize:11,color:"var(--muted)",fontFamily:"'DM Sans'"}}>{s.d}</div></div>)}
    </div>
  </div>;
}
function FXMini({data,color="#FF1744"}){
  const VW=320,VH=110,pad={t:6,r:8,b:4,l:48},W=VW-pad.l-pad.r,H=VH-pad.t-pad.b;
  const rates=data.map(d=>d.rate),mn=Math.min(...rates),mx=Math.max(...rates),rng=mx-mn||1;
  const xS=i=>pad.l+(i/(data.length-1||1))*W,yS=v=>pad.t+(1-(v-(mn-rng*0.05))/(rng*1.1))*H;
  const path=rates.map((v,i)=>`${i===0?"M":"L"}${xS(i)},${yS(v)}`).join(" ");
  const gid=`fm${hashStr(color)}`;
  return<svg width="100%" viewBox={`0 0 ${VW} ${VH}`} style={{display:"block"}}><defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.12}/><stop offset="100%" stopColor={color} stopOpacity={0}/></linearGradient></defs>
    {[mn,(mn+mx)/2,mx].map((v,i)=><g key={i}><line x1={pad.l} x2={VW-pad.r} y1={yS(v)} y2={yS(v)} stroke="var(--grid)" strokeWidth={0.5}/><text x={pad.l-4} y={yS(v)+3} textAnchor="end" fill="var(--muted)" fontSize={8.5} fontFamily="'DM Sans'">{v.toFixed(0)}</text></g>)}
    <path d={`${path} L${xS(data.length-1)},${pad.t+H} L${xS(0)},${pad.t+H} Z`} fill={`url(#${gid})`}/><path d={path} fill="none" stroke={color} strokeWidth={1.3}/></svg>;
}

/* ═══ App ═══ */
export default function App(){
  const [tab,setTab]=useState("market"),[cur,setCur]=useState("VES"),[sel,setSel]=useState(null);
  const [search,setSearch]=useState(""),[ind,setInd]=useState("ALL"),[ibcTf,setIbcTf]=useState("3M");
  const [wl,setWL]=useState(["RST","BPV","BNC","MVZ.A","BVCC"]);
  const [ibcSt,setIbcSt]=useState({value:0,pct:0,date:null,hover:false});
  const [sticky,setSticky]=useState(false);
  const togW=t=>setWL(w=>w.includes(t)?w.filter(x=>x!==t):[...w,t]);
  const maxFxD=FX_MAX_DAYS[cur]||99999;
  const filtered=useMemo(()=>{let l=STOCKS;if(tab==="watchlist")l=l.filter(s=>wl.includes(s.ticker));if(ind!=="ALL")l=l.filter(s=>s.industry===ind);if(search){const q=search.toLowerCase();l=l.filter(s=>s.ticker.toLowerCase().includes(q)||s.name.toLowerCase().includes(q));}return l;},[tab,ind,search,wl]);
  const ibcTfs=TFS.filter(t=>t.days<=maxFxD||t.days===0);

  const CurBar=()=><div style={{display:"flex",gap:4,padding:"6px 0",overflowX:"auto",flexShrink:0}}>
    {Object.entries(FX).map(([k,v])=>{const a=cur===k,isPar=k==="USD_PAR",lbl=k==="VES"?"VES":k==="USD_BCV"?"$ BCV":k==="EUR_BCV"?"€ BCV":"$ Paralelo";
      if(isPar)return<button key={k} onClick={()=>setCur(k)} style={{padding:"5px 12px",borderRadius:20,border:a?"none":"1.5px solid #F59E0B",background:a?"linear-gradient(135deg,#F59E0B,#EF4444)":"transparent",color:a?"#fff":"#F59E0B",fontSize:11,cursor:"pointer",fontFamily:"'DM Sans'",fontWeight:700,whiteSpace:"nowrap",flexShrink:0,boxShadow:a?"0 2px 8px rgba(245,158,11,0.35)":"none",letterSpacing:"0.3px"}}>⚡ {lbl}</button>;
      return<button key={k} onClick={()=>setCur(k)} style={{padding:"5px 10px",borderRadius:20,border:"1px solid var(--border)",background:a?"var(--accent)":"transparent",color:a?"#fff":"var(--muted)",fontSize:11,cursor:"pointer",fontFamily:"'DM Sans'",fontWeight:600,whiteSpace:"nowrap",flexShrink:0}}>{v.flag} {lbl}</button>;})}
    <button onClick={()=>setSticky(s=>!s)} style={{padding:"5px 8px",borderRadius:20,border:"1px solid var(--border)",background:sticky?"var(--text)":"transparent",color:sticky?"var(--bg)":"var(--muted)",fontSize:11,cursor:"pointer",fontFamily:"'DM Sans'",fontWeight:500,flexShrink:0}}>📌</button>
  </div>;

  if(sel)return<div style={rootSt}><style>{css}</style><div style={shellSt}>{sticky?<div style={{position:"sticky",top:0,zIndex:50,background:"var(--bg)",paddingBottom:2}}><CurBar/></div>:<CurBar/>}<StockDetail stock={sel} cur={cur} onBack={()=>setSel(null)}/></div></div>;

  return<div style={rootSt}><style>{css}</style><div style={shellSt}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0 4px"}}><div><div style={{fontSize:20,fontWeight:800,color:"var(--text)",fontFamily:"'DM Sans'",letterSpacing:"-0.5px"}}>BVC</div><div style={{fontSize:11,color:"var(--muted)",fontFamily:"'DM Sans'"}}>Bolsa de Valores de Caracas</div></div><div style={{fontSize:10,color:"var(--muted)",fontFamily:"'DM Sans'",textAlign:"right"}}><div>26 Mar 2026</div><div>Bs/$BCV: 462,67</div></div></div>
    {sticky?<div style={{position:"sticky",top:0,zIndex:50,background:"var(--bg)",paddingBottom:2}}><CurBar/></div>:<CurBar/>}
    <div style={{flex:1,overflowY:"auto",paddingBottom:70}}>
      {tab==="fx"?<FXTab/>:<>
        <div style={{background:"var(--card)",borderRadius:16,padding:"14px 14px 8px",marginTop:8,marginBottom:12,border:"1px solid var(--border)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
            <div><div style={{fontSize:12,color:"var(--muted)",fontFamily:"'DM Sans'",fontWeight:600}}>IBC{cur==="USD_PAR"?" — Retorno Real":""}</div><div style={{fontSize:24,fontWeight:800,color:"var(--text)",fontFamily:"'DM Sans'"}}>{fmtP(ibcSt.value,cur)}</div><div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:13,fontWeight:700,color:ibcSt.pct>=0?"#00C853":"#FF1744",fontFamily:"'DM Sans'"}}>{fmtPct(ibcSt.pct)}</span>{ibcSt.hover&&ibcSt.date&&<span style={{fontSize:11,color:"var(--muted)",fontFamily:"'DM Sans'"}}>{ibcTf==="1D"?fmtTime(ibcSt.date):fmtDate(ibcSt.date)}</span>}</div></div>
            <div style={{textAlign:"right"}}><div style={{fontSize:10,color:"var(--muted)",fontFamily:"'DM Sans'"}}>Financiero</div><div style={{fontSize:13,fontWeight:700,color:"var(--text)",fontFamily:"'DM Sans'"}}>{fmtP(toFX(IBC_FIN,cur),cur)}</div><div style={{fontSize:10,color:"var(--muted)",fontFamily:"'DM Sans'",marginTop:2}}>Industrial</div><div style={{fontSize:13,fontWeight:700,color:"var(--text)",fontFamily:"'DM Sans'"}}>{fmtP(toFX(IBC_IND,cur),cur)}</div></div>
          </div>
          <IBCChart cur={cur} tf={ibcTf} onStats={setIbcSt}/>
          <div style={{display:"flex",gap:4,justifyContent:"center",paddingTop:4,flexWrap:"wrap"}}>{ibcTfs.map(t=><button key={t.key} onClick={()=>setIbcTf(t.key)} style={{padding:"3px 10px",borderRadius:12,border:"none",background:ibcTf===t.key?"var(--text)":"transparent",color:ibcTf===t.key?"var(--bg)":"var(--muted)",fontSize:10,cursor:"pointer",fontFamily:"'DM Sans'",fontWeight:600}}>{t.label}</button>)}</div>
          {cur!=="VES"&&<div style={{fontSize:9,color:"var(--muted)",fontFamily:"'DM Sans'",textAlign:"center",marginTop:4}}>Datos FX: {cur==="USD_PAR"?"2 años":"3 años"}</div>}
        </div>
        <div style={{position:"relative",marginBottom:8}}><input type="text" placeholder="Buscar acciones..." value={search} onChange={e=>setSearch(e.target.value)} style={{width:"100%",padding:"10px 12px 10px 36px",borderRadius:12,border:"1px solid var(--border)",background:"var(--card)",color:"var(--text)",fontSize:13,fontFamily:"'DM Sans'",outline:"none",boxSizing:"border-box"}}/><span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:15,color:"var(--muted)"}}>🔍</span></div>
        <div style={{display:"flex",gap:4,overflowX:"auto",paddingBottom:8,flexShrink:0}}>{["ALL",...new Set(STOCKS.map(s=>s.industry))].map(id=><button key={id} onClick={()=>setInd(id)} style={{padding:"4px 10px",borderRadius:16,border:"1px solid var(--border)",background:ind===id?"var(--text)":"transparent",color:ind===id?"var(--bg)":"var(--muted)",fontSize:10,cursor:"pointer",fontFamily:"'DM Sans'",fontWeight:600,whiteSpace:"nowrap",flexShrink:0}}>{IND[id]?.i} {IND[id]?.l}</button>)}</div>
        <div style={{display:"flex",flexDirection:"column",gap:2}}>
          {filtered.map(stock=>{
            const d90=stock.daily.slice(Math.max(0,stock.daily.length-Math.min(90,maxFxD)-1));
            const fC=vesAtDate(d90[0],cur),lC=vesAtDate(d90[d90.length-1],cur);
            const pct=fC.open?((lC.close-fC.open)/fC.open)*100:0,up=pct>=0;
            const sp=d90.slice(-30).map(d=>vesAtDate(d,cur).close),spMn=Math.min(...sp),spMx=Math.max(...sp),spR=spMx-spMn||1,spW=58,spH=26;
            const spP=sp.map((v,i)=>`${i===0?"M":"L"}${(i/(sp.length-1))*spW},${spH-((v-spMn)/spR)*spH}`).join(" ");
            return<div key={stock.ticker} onClick={()=>setSel(stock)} style={{display:"flex",alignItems:"center",padding:"10px 8px",borderRadius:12,cursor:"pointer",transition:"background 0.15s"}} onMouseEnter={e=>e.currentTarget.style.background="var(--card)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{fontSize:24,marginRight:10,width:32,textAlign:"center",flexShrink:0}}>{stock.logo}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}><div style={{fontSize:14,fontWeight:700,color:"var(--text)",fontFamily:"'DM Sans'"}}>{stock.ticker}</div><div style={{fontSize:14,fontWeight:700,color:"var(--text)",fontFamily:"'DM Sans'",textAlign:"right"}}>{fmtP(lC.close,cur)}</div></div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{fontSize:11,color:"var(--muted)",fontFamily:"'DM Sans'",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:120}}>{stock.name}</div><div style={{display:"flex",alignItems:"center",gap:6}}><svg width={spW} height={spH} style={{display:"block",flexShrink:0}}><path d={spP} fill="none" stroke={up?"#00C853":"#FF1744"} strokeWidth={1.1}/></svg><div style={{fontSize:12,fontWeight:700,color:up?"#00C853":"#FF1744",fontFamily:"'DM Sans'",minWidth:52,textAlign:"right"}}>{fmtPct(pct)}</div></div></div>
              </div>
              <button onClick={e=>{e.stopPropagation();togW(stock.ticker);}} style={{background:"none",border:"none",fontSize:16,cursor:"pointer",padding:"0 0 0 6px",color:wl.includes(stock.ticker)?"#FFB300":"var(--muted)",flexShrink:0}}>{wl.includes(stock.ticker)?"★":"☆"}</button>
            </div>;})}
          {filtered.length===0&&<div style={{padding:32,textAlign:"center",color:"var(--muted)",fontSize:14,fontFamily:"'DM Sans'"}}>No se encontraron acciones</div>}
        </div>
      </>}
    </div>
    <div style={{position:"fixed",bottom:0,left:0,right:0,background:"var(--card)",borderTop:"1px solid var(--border)",display:"flex",justifyContent:"space-around",padding:"6px 0 env(safe-area-inset-bottom,8px)",zIndex:100,backdropFilter:"blur(12px)"}}>
      {[{k:"market",i:"📊",l:"Mercado"},{k:"watchlist",i:"⭐",l:"Watchlist"},{k:"fx",i:"💱",l:"FX"}].map(t=><button key={t.k} onClick={()=>{setTab(t.k);setSel(null);}} style={{background:"none",border:"none",display:"flex",flexDirection:"column",alignItems:"center",gap:2,cursor:"pointer",padding:"4px 16px",color:tab===t.k?"var(--accent)":"var(--muted)"}}><span style={{fontSize:18}}>{t.i}</span><span style={{fontSize:10,fontWeight:600,fontFamily:"'DM Sans'"}}>{t.l}</span></button>)}
    </div>
  </div></div>;
}

const css=`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');:root{--bg:#F8F9FB;--card:#FFF;--text:#0D1117;--muted:#6B7280;--border:#E5E7EB;--accent:#0066FF;--grid:#F0F0F0;}*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}body{margin:0;background:var(--bg);}input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}input[type=number]{-moz-appearance:textfield;}::-webkit-scrollbar{width:0;height:0;}`;
const rootSt={width:"100%",minHeight:"100vh",background:"var(--bg)",display:"flex",justifyContent:"center",fontFamily:"'DM Sans',sans-serif"};
const shellSt={width:"100%",maxWidth:430,minHeight:"100vh",padding:"0 16px",position:"relative",display:"flex",flexDirection:"column"};
