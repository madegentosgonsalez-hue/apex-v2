import { useState, useEffect, useRef, useCallback } from "react";

const ALL_PAIRS = {
  FOREX: ["EURUSD","XAUUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","GBPJPY","EURJPY","NZDUSD","USDCHF"],
  CRYPTO: ["BTCUSD","ETHUSD","SOLUSD","BNBUSD","XRPUSD"],
  STOCKS: ["SPY","NVDA","AAPL"],
  FUTURES: ["ES1","GC1"],
};

const BASE_PRICES = {
  EURUSD:1.0847,XAUUSD:2330.5,GBPUSD:1.2634,USDJPY:149.5,AUDUSD:0.6521,USDCAD:1.3612,
  GBPJPY:188.9,EURJPY:162.1,NZDUSD:0.6021,USDCHF:0.9087,BTCUSD:67450,ETHUSD:3210,
  SOLUSD:178.5,BNBUSD:412.3,XRPUSD:0.5821,SPY:528.5,NVDA:875.2,AAPL:189.4,ES1:5280,GC1:2331,
};

const FTMO_ACCOUNTS=[
  {size:10000,label:"$10K",profit:10,daily:5,loss:10},
  {size:25000,label:"$25K",profit:10,daily:5,loss:10},
  {size:50000,label:"$50K",profit:10,daily:5,loss:10},
  {size:100000,label:"$100K",profit:10,daily:5,loss:10},
  {size:200000,label:"$200K",profit:10,daily:5,loss:10},
];

const DEFAULT={
  mode:"STANDARD",accountSize:10000,ftmoAccount:10000,
  ftmoProfitTarget:10,ftmoMaxDaily:5,ftmoMaxLoss:10,
  diamondRisk:2.0,goldRisk:1.5,silverRisk:1.0,
  diamondConv:88,goldConv:75,silverConv:65,
  dailyLossLimit:3,paperMode:true,
};

const TIER_CFG={DIAMOND:{color:"#00ffcc",icon:"💎"},GOLD:{color:"#FFD700",icon:"🥇"},SILVER:{color:"#C0C0C0",icon:"🥈"}};
const DIR_CFG={
  BUY:{color:"#00d4aa",bg:"rgba(0,212,170,.08)",border:"rgba(0,212,170,.28)",label:"▲ BUY"},
  SELL:{color:"#ff4757",bg:"rgba(255,71,87,.08)",border:"rgba(255,71,87,.28)",label:"▼ SELL"},
  READY:{color:"#ffa502",bg:"rgba(255,165,2,.08)",border:"rgba(255,165,2,.28)",label:"◈ READY"},
  WAIT:{color:"#333",bg:"rgba(255,255,255,.02)",border:"rgba(255,255,255,.05)",label:"— WAIT"},
};
const REGIME_C={TRENDING:"#00d4aa",RANGING:"#ffa502",WEAK_TREND:"#a29bfe",HIGH_VOLATILITY:"#ff4757"};

function fmtP(v,s){if(v==null)return"—";if(s==="XAUUSD"||s==="GC1")return Number(v).toFixed(2);if(s?.includes("JPY"))return Number(v).toFixed(3);if(["BTCUSD","ETHUSD"].includes(s))return Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});return Number(v).toFixed(5);}
function riskPct(cfg,tier){return({DIAMOND:cfg.diamondRisk,GOLD:cfg.goldRisk,SILVER:cfg.silverRisk})[tier]||1;}
function riskUSD(cfg,tier){const acc=cfg.mode==="FTMO"?cfg.ftmoAccount:cfg.accountSize;return((riskPct(cfg,tier)/100)*acc).toFixed(0);}

function mockSig(pair,forced,cfg){
  const dir=Math.random()>.5?"BUY":"SELL";
  const score=Math.min(6,4+Math.floor(Math.random()*3));
  const conv=65+Math.floor(Math.random()*26);
  const tier=score===6?"DIAMOND":score===5?"GOLD":"SILVER";
  const base=BASE_PRICES[pair]||100;const atr=base*.003;
  const entry=parseFloat((base+(Math.random()-.5)*atr*.5).toFixed(5));
  const risk=atr*(1.5+Math.random());
  const sl=dir==="BUY"?entry-risk:entry+risk;
  const tp1=dir==="BUY"?entry+risk*2:entry-risk*2;
  const tp2=dir==="BUY"?entry+risk*3:entry-risk*3;
  const et=["TYPE_A","TYPE_B","TYPE_C","TYPE_D"][Math.floor(Math.random()*4)];
  const regime=["TRENDING","RANGING","WEAK_TREND"][Math.floor(Math.random()*3)];
  const session=["LONDON_NY_OVERLAP","LONDON","NEW_YORK","ASIAN"][Math.floor(Math.random()*4)];
  const bR=["Daily uptrend intact","Liquidity sweep below swing low","H4 OB + FVG confluence","RSI reset — momentum turning bullish","DXY weakness — tailwind","H2 bridge confirms"];
  const sR=["Daily downtrend — LH/LL","Liquidity sweep above swing high","H4 bearish OB rejecting","RSI divergence at overbought","DXY strength rising","H2 bridge confirms bearish"];
  const reasons=(dir==="BUY"?bR:sR).sort(()=>Math.random()-.5).slice(0,3);
  const aiNotes=["All confluence aligned.","Liquidity sweep confirmed.","News approaching.","Correlated pair confirms.","Volatility within ATR."];
  const sigType=forced||(score>=5&&conv>=75?dir:score===4?"READY":"WAIT");
  const r=cfg?riskPct(cfg,tier):(tier==="DIAMOND"?2:tier==="GOLD"?1.5:1);
  return{id:`sig_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,pair,direction:dir,type:sigType,tier,score,conv,regime,session,entryType:et,entry:parseFloat(entry.toFixed(5)),sl:parseFloat(sl.toFixed(5)),tp1:parseFloat(tp1.toFixed(5)),tp2:parseFloat(tp2.toFixed(5)),rr:2.1,risk:r,reasons,aiNote:aiNotes[Math.floor(Math.random()*aiNotes.length)],htf:true,keyLevel:true,volume:score>=5,rsiOk:true,candle:score>=4,intermarket:score===6,timestamp:new Date(),status:"ACTIVE"};
}

const css=`
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Barlow:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
::-webkit-scrollbar{width:3px;height:3px}::-webkit-scrollbar-track{background:#080808}::-webkit-scrollbar-thumb{background:#1a1a1a;border-radius:2px}
@keyframes live-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.15)}}
@keyframes ring-out{0%{transform:scale(.7);opacity:.9}100%{transform:scale(2.2);opacity:0}}
@keyframes slide-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.slide-in{animation:slide-in .2s ease forwards}
input[type=range]{-webkit-appearance:none;height:3px;border-radius:2px;background:#1a1a1a;outline:none;width:100%}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;cursor:pointer}
`;

function NavButton({label,icon,active,onClick}){
  return(
    <button onClick={onClick} style={{
      width:"100%",padding:"10px 12px",borderRadius:6,cursor:"pointer",
      background:active?"rgba(0,212,170,.1)":"transparent",
      border:`1px solid ${active?"rgba(0,212,170,.3)":"#111"}`,
      color:active?"#00d4aa":"#333",fontSize:10,fontWeight:700,
      fontFamily:"'IBM Plex Mono',monospace",letterSpacing:".08em",
      display:"flex",alignItems:"center",gap:8,transition:"all .2s",
      textAlign:"left",marginBottom:4,
    }}>
      <span style={{fontSize:14}}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function Dot({color="#00d4aa",size=6}){return(<span style={{position:"relative",display:"inline-flex",alignItems:"center",justifyContent:"center",width:size+10,height:size+10}}><span style={{position:"absolute",inset:0,borderRadius:"50%",background:color,opacity:.2,animation:"ring-out 1.8s ease-out infinite"}}/><span style={{width:size,height:size,borderRadius:"50%",background:color,animation:"live-pulse 2s ease infinite",flexShrink:0}}/></span>);}
function CBar({score}){const c=score>=5?"#00d4aa":score>=4?"#ffa502":"#ff4757";return(<div style={{display:"flex",gap:2,alignItems:"center"}}>{[1,2,3,4,5,6].map(i=><div key={i} style={{width:9,height:9,borderRadius:2,background:i<=score?c:"rgba(255,255,255,.04)",border:`1px solid ${i<=score?c+"55":"rgba(255,255,255,.04)"}`,transition:"all .3s"}}/>)}<span style={{fontSize:9,color:"#333",fontFamily:"'IBM Plex Mono',monospace",marginLeft:2}}>{score}/6</span></div>);}
function Chip({children,color="#444",bg="rgba(255,255,255,.02)"}){return<span style={{fontSize:9,fontWeight:600,letterSpacing:".08em",padding:"2px 7px",borderRadius:3,background:bg,color,border:`1px solid ${color}22`,fontFamily:"'IBM Plex Mono',monospace",whiteSpace:"nowrap"}}>{children}</span>;}
function StatBox({label,value,sub,color="#00d4aa",accent}){return(<div style={{background:"#080808",border:`1px solid ${accent?color+"18":"#0e0e0e"}`,borderRadius:6,padding:"13px 16px",boxShadow:accent?`0 0 18px ${color}05`:""}}><div style={{fontSize:8,color:"#222",letterSpacing:".15em",marginBottom:5,fontFamily:"'IBM Plex Mono',monospace"}}>{label}</div><div style={{fontSize:24,fontWeight:800,color,fontFamily:"'Barlow',sans-serif",lineHeight:1}}>{value}</div>{sub&&<div style={{fontSize:9,color:"#252525",marginTop:4,fontFamily:"'IBM Plex Mono',monospace"}}>{sub}</div>}</div>);}

function SignalCard({sig,onClose,cfg}){
  const [open,setOpen]=useState(false);
  const dc=DIR_CFG[sig.type]||DIR_CFG.WAIT;
  const tc=TIER_CFG[sig.tier]||TIER_CFG.SILVER;
  const isLive=["BUY","SELL"].includes(sig.type);
  const rc=REGIME_C[sig.regime]||"#444";
  const dr=riskUSD(cfg,sig.tier);
  const isFTMO=cfg.mode==="FTMO";
  return(
    <div className="slide-in" style={{background:"#080808",border:`1px solid ${isLive?dc.border:"#111"}`,borderLeft:`3px solid ${isLive?dc.color:"#1a1a1a"}`,borderRadius:6,overflow:"hidden",cursor:"pointer",transition:"all .2s",boxShadow:isLive?`0 0 22px ${dc.color}05`:""}} onClick={()=>setOpen(o=>!o)}>
      {isLive&&<div style={{height:1,background:`linear-gradient(90deg,transparent,${dc.color}30,transparent)`}}/>}
      <div style={{padding:"11px 14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:7}}>
            {isLive&&<Dot color={dc.color}/>}
            <span style={{fontFamily:"'Barlow',sans-serif",fontSize:15,fontWeight:800,color:"#f0f0f0",letterSpacing:".04em"}}>{sig.pair}</span>
            <span style={{fontSize:10,fontWeight:700,padding:"2px 9px",borderRadius:3,background:dc.bg,color:dc.color,border:`1px solid ${dc.border}`,fontFamily:"'IBM Plex Mono',monospace"}}>{dc.label}</span>
            {isLive&&<span style={{fontSize:9,padding:"2px 7px",borderRadius:3,background:`${tc.color}10`,color:tc.color,border:`1px solid ${tc.color}20`,fontFamily:"'IBM Plex Mono',monospace",fontWeight:700}}>{tc.icon} {sig.tier}</span>}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:8,color:"#1c1c1c",fontFamily:"'IBM Plex Mono',monospace"}}>{sig.timestamp.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>
            {onClose&&<button onClick={e=>{e.stopPropagation();onClose(sig.id);}} style={{background:"none",border:"none",color:"#222",cursor:"pointer",fontSize:11,lineHeight:1,padding:"2px 3px"}} onMouseOver={e=>e.target.style.color="#666"} onMouseOut={e=>e.target.style.color="#222"}>✕</button>}
          </div>
        </div>
        <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center",marginBottom:isLive?10:0}}>
          <CBar score={sig.score}/><Chip color="#a29bfe">AI {sig.conv}%</Chip>
          <Chip color={rc}>{sig.regime}</Chip><Chip color="#333">{sig.session?.replace(/_/g," ")}</Chip>
          <Chip color="#222">{sig.entryType}</Chip>
          {isLive&&<Chip color="#00d4aa">{sig.risk}% / ${dr}</Chip>}
        </div>
        {isLive&&(<div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4}}><div style={{textAlign:"center",padding:"6px 8px",background:"rgba(255,255,255,.02)",borderRadius:4}}><div style={{fontSize:8,color:"#282828",letterSpacing:".1em",marginBottom:3,fontFamily:"'IBM Plex Mono',monospace"}}>ENTRY</div><div style={{fontSize:11,fontWeight:700,color:"#e8e8e8",fontFamily:"'IBM Plex Mono',monospace"}}>{fmtP(sig.entry,sig.pair)}</div></div><div style={{textAlign:"center",padding:"6px 8px",background:"rgba(255,255,255,.02)",borderRadius:4}}><div style={{fontSize:8,color:"#282828",letterSpacing:".1em",marginBottom:3,fontFamily:"'IBM Plex Mono',monospace"}}>STOP LOSS</div><div style={{fontSize:11,fontWeight:700,color:"#ff4757",fontFamily:"'IBM Plex Mono',monospace"}}>{fmtP(sig.sl,sig.pair)}</div></div><div style={{textAlign:"center",padding:"6px 8px",background:"rgba(255,255,255,.02)",borderRadius:4}}><div style={{fontSize:8,color:"#282828",letterSpacing:".1em",marginBottom:3,fontFamily:"'IBM Plex Mono',monospace"}}>TP1 1:2</div><div style={{fontSize:11,fontWeight:700,color:"#00d4aa",fontFamily:"'IBM Plex Mono',monospace"}}>{fmtP(sig.tp1,sig.pair)}</div></div><div style={{textAlign:"center",padding:"6px 8px",background:"rgba(255,255,255,.02)",borderRadius:4}}><div style={{fontSize:8,color:"#282828",letterSpacing:".1em",marginBottom:3,fontFamily:"'IBM Plex Mono',monospace"}}>TP2 1:3</div><div style={{fontSize:11,fontWeight:700,color:"#00ff99",fontFamily:"'IBM Plex Mono',monospace"}}>{fmtP(sig.tp2,sig.pair)}</div></div></div>)}
      </div>
      {open&&(<div style={{borderTop:"1px solid #0e0e0e",padding:"12px 14px",background:"#050505"}}><div style={{marginBottom:10}}><div style={{fontSize:8,color:"#252525",letterSpacing:".15em",marginBottom:6,fontFamily:"'IBM Plex Mono',monospace"}}>WHY THIS SETUP</div>{sig.reasons.map((r,i)=><div key={i} style={{fontSize:10,color:"#5a5a5a",marginBottom:5,paddingLeft:10,borderLeft:"2px solid #181818",lineHeight:1.5}}>{r}</div>)}</div><div style={{background:"rgba(162,155,254,.04)",border:"1px solid rgba(162,155,254,.1)",borderRadius:5,padding:"9px 11px",marginBottom:10}}><div style={{fontSize:8,color:"#a29bfe",letterSpacing:".15em",marginBottom:4,fontFamily:"'IBM Plex Mono',monospace"}}>🤖 AI ANALYST</div><div style={{fontSize:10,color:"#606070",fontStyle:"italic",lineHeight:1.6}}>{sig.aiNote}</div></div></div>)}
    </div>
  );
}

// ── ACCOUNT MANAGEMENT PANEL ──────────────────────────────────────────
function AccountManager({cfg,onCfgChange,signals,onArchive}){
  const [confirmReset,setConfirmReset]=useState(false);
  const [newAccountName,setNewAccountName]=useState("");

  const handleReset=()=>{
    if(confirmReset){
      onArchive(signals);
      onCfgChange(DEFAULT);
      setConfirmReset(false);
      alert("Account reset. Previous trades moved to Learning Archive.");
    }else{
      setConfirmReset(true);
    }
  };

  const handleNewAccount=()=>{
    if(newAccountName.trim()){
      onArchive(signals);
      onCfgChange({...DEFAULT,_accountName:newAccountName});
      setNewAccountName("");
      alert(`New account created: "${newAccountName}". Previous trades archived.`);
    }
  };

  return(
    <div style={{maxHeight:"calc(100vh - 300px)",overflowY:"auto",paddingRight:4}}>
      <div style={{fontSize:8,color:"#252525",letterSpacing:".15em",marginBottom:14,fontFamily:"'IBM Plex Mono',monospace",textTransform:"uppercase"}}>Account Management</div>

      {/* Current Account */}
      <div style={{background:"#080808",border:"1px solid #0e0e0e",borderRadius:6,padding:"14px",marginBottom:12}}>
        <div style={{fontSize:10,color:"#00d4aa",fontWeight:700,marginBottom:8}}>📊 Current Account</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <div style={{textAlign:"center",padding:"8px",background:"rgba(255,255,255,.02)",borderRadius:4}}>
            <div style={{fontSize:8,color:"#333",fontFamily:"'IBM Plex Mono',monospace"}}>Mode</div>
            <div style={{fontSize:11,fontWeight:700,color:"#e0e0e0",marginTop:4}}>{cfg.mode}</div>
          </div>
          <div style={{textAlign:"center",padding:"8px",background:"rgba(255,255,255,.02)",borderRadius:4}}>
            <div style={{fontSize:8,color:"#333",fontFamily:"'IBM Plex Mono',monospace"}}>Size</div>
            <div style={{fontSize:11,fontWeight:700,color:"#e0e0e0",marginTop:4}}>${(cfg.mode==="FTMO"?cfg.ftmoAccount:cfg.accountSize).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* New Account */}
      <div style={{background:"#080808",border:"1px solid #0e0e0e",borderRadius:6,padding:"14px",marginBottom:12}}>
        <div style={{fontSize:10,color:"#ffa502",fontWeight:700,marginBottom:8}}>➕ Start New Account</div>
        <input type="text" placeholder="Account name (FTMO Challenge #2, etc)" value={newAccountName} onChange={e=>setNewAccountName(e.target.value)} style={{width:"100%",padding:"8px",borderRadius:4,border:"1px solid #1a1a1a",background:"#0e0e0e",color:"#e0e0e0",fontFamily:"'IBM Plex Mono',monospace",fontSize:10,marginBottom:8}}/>
        <button onClick={handleNewAccount} disabled={!newAccountName.trim()} style={{width:"100%",padding:"8px",borderRadius:4,border:"1px solid rgba(255,165,2,.3)",background:"rgba(255,165,2,.08)",color:"#ffa502",cursor:newAccountName.trim()?"pointer":"not-allowed",fontSize:10,fontWeight:700,fontFamily:"'IBM Plex Mono',monospace",transition:"all .2s"}}>Create New Account</button>
        <div style={{fontSize:8,color:"#333",marginTop:6,fontFamily:"'IBM Plex Mono',monospace"}}>All current trades archived as learning material</div>
      </div>

      {/* Reset Current Account */}
      <div style={{background:"rgba(255,71,87,.04)",border:"1px solid rgba(255,71,87,.15)",borderRadius:6,padding:"14px"}}>
        <div style={{fontSize:10,color:"#ff4757",fontWeight:700,marginBottom:8}}>⚠️ Reset Current Account</div>
        <button onClick={handleReset} style={{width:"100%",padding:"8px",borderRadius:4,border:`1px solid ${confirmReset?"#ff4757":"rgba(255,71,87,.3)"}`,background:confirmReset?"rgba(255,71,87,.15)":"rgba(255,71,87,.08)",color:"#ff4757",cursor:"pointer",fontSize:10,fontWeight:700,fontFamily:"'IBM Plex Mono',monospace",transition:"all .2s"}}>
          {confirmReset?"⚠️ CONFIRM RESET":"Reset All Data to 0"}
        </button>
        <div style={{fontSize:8,color:"#333",marginTop:6,fontFamily:"'IBM Plex Mono',monospace"}}>All trades moved to archive. Counters reset to zero.</div>
      </div>
    </div>
  );
}

// ── SETTINGS PANEL ────────────────────────────────────────────────────
function Settings({cfg,onChange}){
  const isFTMO=cfg.mode==="FTMO";
  const acc=isFTMO?cfg.ftmoAccount:cfg.accountSize;

  const set=(k,v)=>onChange({...cfg,[k]:v});
  const applyFTMO=(size)=>onChange({...cfg,ftmoAccount:size,ftmoProfitTarget:10,ftmoMaxDaily:5,ftmoMaxLoss:10,diamondRisk:1.0,goldRisk:0.75,silverRisk:0.5});
  const applyStd=()=>onChange({...cfg,mode:"STANDARD",diamondRisk:2.0,goldRisk:1.5,silverRisk:1.0});

  return(
    <div style={{maxHeight:"calc(100vh - 300px)",overflowY:"auto",paddingRight:4}}>
      <div style={{fontSize:8,color:"#252525",letterSpacing:".15em",marginBottom:14,fontFamily:"'IBM Plex Mono',monospace",textTransform:"uppercase"}}>Trading Settings</div>

      {/* Mode */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
        {["STANDARD","FTMO"].map(m=>(
          <button key={m} onClick={()=>{set("mode",m);if(m==="FTMO")applyFTMO(cfg.ftmoAccount);else applyStd();}} style={{padding:"10px 8px",borderRadius:6,cursor:"pointer",background:cfg.mode===m?(m==="FTMO"?"rgba(255,165,2,.1)":"rgba(0,212,170,.08)"):"#080808",border:`1px solid ${cfg.mode===m?(m==="FTMO"?"rgba(255,165,2,.3)":"rgba(0,212,170,.25)"):"#111"}`,color:cfg.mode===m?(m==="FTMO"?"#ffa502":"#00d4aa"):"#444",fontFamily:"'IBM Plex Mono',monospace",fontWeight:700,fontSize:11,letterSpacing:".08em",transition:"all .2s"}}>{m==="FTMO"?"🏆 FTMO":"📊 STANDARD"}</button>
        ))}
      </div>

      {/* Risk Settings */}
      <div style={{background:"#080808",border:"1px solid #0e0e0e",borderRadius:6,padding:"14px",marginBottom:12}}>
        <div style={{fontSize:8,color:"#252525",letterSpacing:".15em",marginBottom:10,fontFamily:"'IBM Plex Mono',monospace"}}>Position Size Per Tier</div>
        {[
          {rKey:"diamondRisk",tier:"DIAMOND",color:"#00ffcc",icon:"💎",rMax:isFTMO?1.5:3},
          {rKey:"goldRisk",tier:"GOLD",color:"#FFD700",icon:"🥇",rMax:isFTMO?1.0:2.5},
          {rKey:"silverRisk",tier:"SILVER",color:"#C0C0C0",icon:"🥈",rMax:isFTMO?0.75:1.5},
        ].map(({rKey,tier,color,icon,rMax})=>(
          <div key={tier} style={{marginBottom:12,paddingBottom:12,borderBottom:"1px solid #0e0e0e"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
              <span style={{fontSize:14}}>{icon}</span>
              <span style={{fontSize:11,fontWeight:700,color,fontFamily:"'Barlow',sans-serif"}}>{tier}</span>
              <span style={{fontSize:9,color:"#333",fontFamily:"'IBM Plex Mono',monospace",marginLeft:"auto"}}>≈${((cfg[rKey]/100)*acc).toFixed(0)}</span>
            </div>
            <div style={{marginBottom:6}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                <span style={{fontSize:10,color:"#b0b0b0"}}>Risk per trade</span>
                <span style={{fontSize:11,fontWeight:700,color,fontFamily:"'IBM Plex Mono',monospace"}}>{cfg[rKey]}%</span>
              </div>
              <input type="range" min={0.25} max={rMax} step={0.25} value={cfg[rKey]} onChange={e=>set(rKey,parseFloat(e.target.value))} style={{accentColor:color,width:"100%"}}/>
            </div>
          </div>
        ))}
      </div>

      {/* Daily Loss Limit */}
      <div style={{background:"#080808",border:"1px solid #0e0e0e",borderRadius:6,padding:"14px",marginBottom:12}}>
        <div style={{fontSize:8,color:"#252525",letterSpacing:".15em",marginBottom:10,fontFamily:"'IBM Plex Mono',monospace"}}>Risk Management</div>
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <span style={{fontSize:10,color:"#b0b0b0"}}>Daily loss limit</span>
            <span style={{fontSize:11,fontWeight:700,color:"#ff4757",fontFamily:"'IBM Plex Mono',monospace"}}>{cfg.dailyLossLimit} losses</span>
          </div>
          <input type="range" min={1} max={6} step={1} value={cfg.dailyLossLimit} onChange={e=>set("dailyLossLimit",parseInt(e.target.value))} style={{accentColor:"#ff4757",width:"100%"}}/>
        </div>
      </div>

      {/* Paper Mode */}
      <div style={{background:"#080808",border:"1px solid #0e0e0e",borderRadius:6,padding:"14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:10,color:"#b0b0b0"}}>Paper Trading Mode</div>
            <div style={{fontSize:8,color:"#333",marginTop:3,fontFamily:"'IBM Plex Mono',monospace"}}>{cfg.paperMode?"Signals only":"⚠️ LIVE MODE"}</div>
          </div>
          <div onClick={()=>set("paperMode",!cfg.paperMode)} style={{width:38,height:20,borderRadius:10,cursor:"pointer",transition:"all .25s",background:cfg.paperMode?"#00d4aa":"#1a1a1a",border:`1px solid ${cfg.paperMode?"#00d4aa55":"#252525"}`,position:"relative",flexShrink:0}}><div style={{position:"absolute",top:2,left:cfg.paperMode?18:2,width:14,height:14,borderRadius:"50%",background:cfg.paperMode?"#030303":"#444",transition:"all .25s"}}/></div>
        </div>
      </div>
    </div>
  );
}

// ── LEARNING ARCHIVE ──────────────────────────────────────────────────
function LearningArchive({archive}){
  return(
    <div style={{maxHeight:"calc(100vh - 300px)",overflowY:"auto",paddingRight:4}}>
      <div style={{fontSize:8,color:"#252525",letterSpacing:".15em",marginBottom:14,fontFamily:"'IBM Plex Mono',monospace",textTransform:"uppercase"}}>📚 Learning Archive</div>

      {(!archive||archive.length===0)?
        <div style={{textAlign:"center",padding:"40px 20px",color:"#333"}}>
          <div style={{fontSize:14,marginBottom:10}}>📦</div>
          <div style={{fontSize:9,fontFamily:"'IBM Plex Mono',monospace"}}>No archived accounts yet</div>
          <div style={{fontSize:8,color:"#1c1c1c",marginTop:4}}>Closed accounts appear here for analysis</div>
        </div>
      :
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {archive.map((acc,i)=>(
            <div key={i} style={{background:"#080808",border:"1px solid #0e0e0e",borderRadius:6,padding:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:11,fontWeight:700,color:"#a29bfe",fontFamily:"'Barlow',sans-serif"}}>{acc.name||`Account ${i+1}`}</div>
                <div style={{fontSize:8,color:"#1c1c1c",fontFamily:"'IBM Plex Mono',monospace"}}>{new Date(acc.closedAt).toLocaleDateString()}</div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                <div style={{textAlign:"center",padding:"6px",background:"rgba(255,255,255,.02)",borderRadius:4}}>
                  <div style={{fontSize:7,color:"#333"}}>Trades</div>
                  <div style={{fontSize:11,fontWeight:700,color:"#e0e0e0"}}>{acc.totalTrades||0}</div>
                </div>
                <div style={{textAlign:"center",padding:"6px",background:"rgba(255,255,255,.02)",borderRadius:4}}>
                  <div style={{fontSize:7,color:"#333"}}>Win Rate</div>
                  <div style={{fontSize:11,fontWeight:700,color:acc.winRate>=50?"#00d4aa":"#ff4757"}}>{(acc.winRate||0).toFixed(0)}%</div>
                </div>
                <div style={{textAlign:"center",padding:"6px",background:"rgba(255,255,255,.02)",borderRadius:4}}>
                  <div style={{fontSize:7,color:"#333"}}>Total R</div>
                  <div style={{fontSize:11,fontWeight:700,color:acc.totalR>0?"#00d4aa":"#ff4757"}}>{(acc.totalR||0).toFixed(1)}R</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      }
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────
export default function Apex(){
  const [activePairs,setActivePairs]=useState(new Set(["EURUSD","XAUUSD"]));
  const [signals,setSignals]=useState([]);
  const [archive,setArchive]=useState([]);
  const [scanning,setScanning]=useState(false);
  const [tab,setTab]=useState("signals");
  const [sideTab,setSideTab]=useState("pairs");
  const [cfg,setCfg]=useState(DEFAULT);

  const isFTMO=cfg.mode==="FTMO";
  const liveSignals=signals.filter(s=>["BUY","SELL"].includes(s.type));
  const readySignals=signals.filter(s=>s.type==="READY");
  const acc=isFTMO?cfg.ftmoAccount:cfg.accountSize;

  useEffect(()=>{
    setSignals([mockSig("EURUSD","BUY",cfg),mockSig("XAUUSD","SELL",cfg)]);
  },[]);

  const runScan=useCallback(async()=>{
    if(scanning)return;setScanning(true);
    for(const pair of activePairs){
      await new Promise(r=>setTimeout(r,400));
      if(Math.random()<0.22){
        const sig=mockSig(pair,undefined,cfg);
        if(["BUY","SELL"].includes(sig.type)) setSignals(p=>[sig,...p].slice(0,25));
      }
    }
    setScanning(false);
  },[scanning,activePairs,cfg]);

  const handleArchive=(sigs)=>{
    const accountData={
      name:cfg._accountName||"Account",
      closedAt:new Date().toISOString(),
      totalTrades:sigs.length,
      winRate:Math.random()*100,
      totalR:(Math.random()*30-10),
      signals:sigs,
    };
    setArchive(p=>[...p,accountData]);
  };

  return(
    <div style={{minHeight:"100vh",background:"#030303",color:"#e0e0e0",fontFamily:"'Barlow',sans-serif",display:"flex"}}>
      <style>{css}</style>

      {/* LEFT SIDEBAR */}
      <div style={{width:220,background:"#050505",borderRight:"1px solid #0e0e0e",display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Logo */}
        <div style={{padding:"16px 14px",borderBottom:"1px solid #0e0e0e"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:28,height:28,borderRadius:6,background:"linear-gradient(135deg,#00d4aa,#00ffcc)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:14,color:"#030303"}}>A</div>
            <div><div style={{fontSize:13,fontWeight:800,color:"#f0f0f0",letterSpacing:".03em"}}>APEX</div><div style={{fontSize:7,color:"#1e1e1e",letterSpacing:".1em",fontFamily:"'IBM Plex Mono',monospace"}}>v1.0</div></div>
          </div>
        </div>

        {/* Navigation */}
        <div style={{padding:"12px",flex:1,overflowY:"auto"}}>
          <div style={{fontSize:7,color:"#1a1a1a",letterSpacing:".2em",marginBottom:8,fontFamily:"'IBM Plex Mono',monospace",textTransform:"uppercase"}}>Trading</div>
          <NavButton label="Signals" icon="📊" active={sideTab==="pairs"} onClick={()=>setSideTab("pairs")}/>
          <NavButton label="Settings" icon="⚙️" active={sideTab==="settings"} onClick={()=>setSideTab("settings")}/>
          <NavButton label="Account" icon="👤" active={sideTab==="account"} onClick={()=>setSideTab("account")}/>
          <NavButton label="Archive" icon="📚" active={sideTab==="archive"} onClick={()=>setSideTab("archive")}/>
        </div>

        {/* Status Footer */}
        <div style={{padding:"12px",borderTop:"1px solid #0e0e0e",fontSize:8,color:"#252525",fontFamily:"'IBM Plex Mono',monospace"}}>
          <div style={{display:"flex",alignItems:"center",gap:3,marginBottom:6}}><div style={{width:4,height:4,borderRadius:"50%",background:"#00d4aa"}}/><span>LIVE</span></div>
          <div style={{fontSize:7,color:"#1c1c1c"}}>{isFTMO?`🏆 ${cfg.ftmoAccount/1000}K`:`📊 ${cfg.accountSize/1000}K`}</div>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* TOPBAR */}
        <div style={{borderBottom:"1px solid #0e0e0e",padding:"0 20px",background:"rgba(3,3,3,.97)",backdropFilter:"blur(12px)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",height:52}}>
            <div><div style={{fontSize:16,fontWeight:800,color:"#f0f0f0",letterSpacing:".03em"}}>APEX SIGNAL SYSTEM</div><div style={{fontSize:8,color:"#1e1e1e",letterSpacing:".1em",fontFamily:"'IBM Plex Mono',monospace"}}>Live Trading Companion</div></div>
            <button onClick={runScan} disabled={scanning} style={{padding:"6px 16px",borderRadius:5,border:`1px solid ${scanning?"#111":"rgba(0,212,170,.25)"}`,background:scanning?"rgba(0,212,170,.02)":"rgba(0,212,170,.07)",color:scanning?"#222":"#00d4aa",cursor:scanning?"default":"pointer",fontSize:9,fontWeight:700,letterSpacing:".1em",fontFamily:"'IBM Plex Mono',monospace",transition:"all .2s"}}>{scanning?"◌ SCANNING...":"▶ SCAN NOW"}</button>
          </div>
        </div>

        {/* STATS ROW */}
        <div style={{padding:"16px 20px",borderBottom:"1px solid #0e0e0e",display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8}}>
          <StatBox label="WIN RATE" value="67%" color="#00d4aa" sub="last 30 days" accent/>
          <StatBox label="TOTAL R" value="+24.3R" color="#00ff99" sub="all time"/>
          <StatBox label="AVG R:R" value="1:2.4" color="#a29bfe" sub="realized"/>
          <StatBox label="ACCOUNT" value={`$${(acc/1000).toFixed(0)}K`} color="#74b9ff"/>
          <StatBox label="TODAY" value="+3.2R" color="#00d4aa" sub="session" accent/>
          <StatBox label="OPEN" value={liveSignals.length} color={liveSignals.length>0?"#ffa502":"#1e1e1e"} sub={`${readySignals.length} ready`}/>
        </div>

        {/* CONTENT AREA */}
        <div style={{flex:1,overflow:"auto",padding:"16px 20px"}}>
          {sideTab==="pairs"&&(
            <div>
              <div style={{fontSize:10,fontWeight:700,color:"#00d4aa",marginBottom:12}}>Active Pairs: {activePairs.size}</div>
              {Object.entries(ALL_PAIRS).map(([market,pairs])=>(
                <div key={market} style={{marginBottom:14}}>
                  <div style={{fontSize:8,color:"#1a1a1a",letterSpacing:".1em",marginBottom:6,fontFamily:"'IBM Plex Mono',monospace",fontWeight:700}}>{market}</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:4}}>
                    {pairs.map(p=>{
                      const on=activePairs.has(p);
                      return(<button key={p} onClick={()=>{setActivePairs(ps=>{const n=new Set(ps);n.has(p)?n.delete(p):n.add(p);return n;});}} style={{padding:"6px 8px",borderRadius:4,border:`1px solid ${on?"rgba(0,212,170,.3)":"#111"}`,background:on?"rgba(0,212,170,.07)":"transparent",color:on?"#00d4aa":"#333",cursor:"pointer",fontSize:9,fontFamily:"'IBM Plex Mono',monospace",fontWeight:on?700:400,transition:"all .15s"}}>{p}</button>);
                    })}
                  </div>
                </div>
              ))}
              <div style={{marginTop:20}}>
                <div style={{fontSize:10,fontWeight:700,color:"#00d4aa",marginBottom:12}}>Recent Signals: {liveSignals.length}</div>
                {liveSignals.length>0?
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {liveSignals.slice(0,5).map(s=><SignalCard key={s.id} sig={s} onClose={id=>setSignals(p=>p.filter(x=>x.id!==id))} cfg={cfg}/>)}
                  </div>
                :
                  <div style={{textAlign:"center",padding:"40px 20px",color:"#1c1c1c"}}>
                    <div style={{fontSize:24,marginBottom:8}}>◌</div>
                    <div style={{fontSize:9,fontFamily:"'IBM Plex Mono',monospace"}}>No active signals</div>
                  </div>
                }
              </div>
            </div>
          )}

          {sideTab==="settings"&&<Settings cfg={cfg} onChange={setCfg}/>}
          {sideTab==="account"&&<AccountManager cfg={cfg} onCfgChange={setCfg} signals={signals} onArchive={handleArchive}/>}
          {sideTab==="archive"&&<LearningArchive archive={archive}/>}
        </div>
      </div>
    </div>
  );
}
