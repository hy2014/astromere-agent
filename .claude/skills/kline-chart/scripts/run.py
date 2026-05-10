#!/usr/bin/env python3
import argparse, csv, html, json, os, re, time
from pathlib import Path

CANDS = {
    "date": ["date", "datetime", "time", "timestamp", "日期", "交易日期"],
    "open": ["open", "o", "开盘", "开盘价"],
    "high": ["high", "h", "最高", "最高价"],
    "low": ["low", "l", "最低", "最低价"],
    "close": ["close", "c", "收盘", "收盘价"],
    "volume": ["volume", "vol", "成交量"],
}

def norm(s):
    return re.sub(r"[\s_\-]+", "", str(s).strip().lower())

def find_col(headers, names, required=True):
    mapping = {norm(h): h for h in headers}
    for name in names:
        if norm(name) in mapping:
            return mapping[norm(name)]
    if required:
        raise SystemExit(f"Missing column. Expected one of {names}. Available: {headers}")
    return None

def num(v):
    return float(str(v).replace(",", "").strip())

def safe(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("._") or "output"

def unique(path):
    if not path.exists():
        return path
    for i in range(2, 10000):
        p = path.with_name(f"{path.stem}_{i}{path.suffix}")
        if not p.exists():
            return p
    raise SystemExit("Cannot create unique output filename")

def read_rows(path):
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        cols = {
            "date": find_col(headers, CANDS["date"]),
            "open": find_col(headers, CANDS["open"]),
            "high": find_col(headers, CANDS["high"]),
            "low": find_col(headers, CANDS["low"]),
            "close": find_col(headers, CANDS["close"]),
            "volume": find_col(headers, CANDS["volume"], False),
        }
        rows = []
        for idx, row in enumerate(reader, 1):
            rows.append({
                "date": str(row.get(cols["date"], "")).strip() or str(idx),
                "open": num(row[cols["open"]]),
                "high": num(row[cols["high"]]),
                "low": num(row[cols["low"]]),
                "close": num(row[cols["close"]]),
                "volume": num(row[cols["volume"]]) if cols["volume"] and str(row.get(cols["volume"], "")).strip() else 0,
            })
    if not rows:
        raise SystemExit("No data rows.")
    return rows, cols

def make_html(title, rows, cols):
    payload = json.dumps(rows, ensure_ascii=False)
    title_e = html.escape(title)
    cols_e = html.escape(", ".join(f"{k}={v}" for k, v in cols.items() if v))
    return f'''<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>{title_e}</title>
<style>
body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,sans-serif}}
.app{{height:100vh;display:grid;grid-template-rows:auto 1fr auto}}
header{{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #334155}}
h1{{font-size:16px;margin:0}}.meta{{font-size:12px;color:#94a3b8;margin-top:4px}}
button{{background:#111827;color:#e5e7eb;border:1px solid #475569;border-radius:8px;padding:6px 10px;cursor:pointer}}
#wrap{{position:relative;overflow:hidden}}canvas{{width:100%;height:100%;display:block}}
#tip{{position:absolute;display:none;background:rgba(15,23,42,.95);border:1px solid #475569;border-radius:8px;padding:8px;font-size:12px;pointer-events:none}}
footer{{padding:8px 16px;border-top:1px solid #334155;color:#94a3b8;font-size:12px;display:flex;justify-content:space-between}}
</style>
</head>
<body>
<div class="app">
<header><div><h1>{title_e}</h1><div class="meta">rows: {len(rows)} · {cols_e}</div></div><div><button onclick="zoom(.75)">Zoom In</button> <button onclick="zoom(1.25)">Zoom Out</button> <button onclick="reset()">Reset</button></div></header>
<div id="wrap"><canvas id="c"></canvas><div id="tip"></div></div>
<footer><span>Wheel zoom · Drag pan · Hover inspect</span><span id="range"></span></footer>
</div>
<script>
const DATA={payload};
const c=document.getElementById('c'), wrap=document.getElementById('wrap'), tip=document.getElementById('tip'), range=document.getElementById('range'), ctx=c.getContext('2d');
let start=Math.max(0,DATA.length-Math.min(DATA.length,120)), end=DATA.length, drag=false, sx=0, ds=0, de=0;
function resize(){{const r=devicePixelRatio||1,b=wrap.getBoundingClientRect();c.width=b.width*r;c.height=b.height*r;ctx.setTransform(r,0,0,r,0,0);draw()}}
function vis(){{return DATA.slice(start,end)}}
function clamp(s,e){{let n=Math.max(10,e-s);s=Math.max(0,Math.min(DATA.length-n,s));return [s,s+n]}}
function yr(rows){{let lo=Infinity,hi=-Infinity;for(const x of rows){{lo=Math.min(lo,x.low);hi=Math.max(hi,x.high)}};let p=(hi-lo)*.08||1;return [lo-p,hi+p]}}
function draw(){{const b=wrap.getBoundingClientRect(),w=b.width,h=b.height;ctx.clearRect(0,0,w,h);let rows=vis();if(!rows.length)return;let L=70,R=w-20,T=18,B=h-48,xw=(R-L)/rows.length,cw=Math.max(2,Math.min(12,xw*.62)),[lo,hi]=yr(rows),Y=p=>T+(hi-p)/(hi-lo)*(B-T);
ctx.strokeStyle='rgba(148,163,184,.18)';ctx.fillStyle='#94a3b8';ctx.font='12px system-ui';ctx.textAlign='right';ctx.textBaseline='middle';
for(let i=0;i<=5;i++){{let y=T+(B-T)*i/5,p=hi-(hi-lo)*i/5;ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(R,y);ctx.stroke();ctx.fillText(p.toFixed(2),L-8,y)}}
for(let i=0;i<rows.length;i++){{let r=rows[i],x=L+i*xw+xw/2,yo=Y(r.open),yc=Y(r.close),yh=Y(r.high),yl=Y(r.low),up=r.close>=r.open,col=up?'#ef4444':'#22c55e';ctx.strokeStyle=ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(x,yh);ctx.lineTo(x,yl);ctx.stroke();ctx.fillRect(x-cw/2,Math.min(yo,yc),cw,Math.max(1,Math.abs(yc-yo)))}}
ctx.fillStyle='#94a3b8';ctx.textAlign='center';ctx.textBaseline='top';let ticks=Math.min(6,rows.length);for(let i=0;i<ticks;i++){{let k=Math.floor(i*(rows.length-1)/Math.max(1,ticks-1)),x=L+k*xw+xw/2;ctx.fillText(rows[k].date,x,B+16)}}range.textContent=`${{DATA[start]?.date||''}} → ${{DATA[end-1]?.date||''}} · ${{end-start}} candles`}}
function zoom(f,ratio=.5){{let n=end-start,nn=Math.max(10,Math.min(DATA.length,Math.round(n*f))),center=start+n*ratio,ns=Math.round(center-nn*ratio);[start,end]=clamp(ns,ns+nn);draw()}}
function reset(){{start=Math.max(0,DATA.length-Math.min(DATA.length,120));end=DATA.length;draw()}}
c.addEventListener('wheel',e=>{{e.preventDefault();let b=c.getBoundingClientRect();zoom(e.deltaY<0?.82:1.18,Math.max(0,Math.min(1,(e.clientX-b.left-70)/(b.width-90))))}},{{passive:false}});
c.addEventListener('mousedown',e=>{{drag=true;sx=e.clientX;ds=start;de=end}});
addEventListener('mouseup',()=>drag=false);
addEventListener('mousemove',e=>{{let b=c.getBoundingClientRect(),rows=vis(),L=70,R=b.width-20,xw=(R-L)/rows.length;if(drag){{let d=Math.round(-(e.clientX-sx)/xw);[start,end]=clamp(ds+d,de+d);draw();return}}let i=Math.floor((e.clientX-b.left-L)/xw);if(i<0||i>=rows.length){{tip.style.display='none';return}}let r=rows[i];tip.style.display='block';tip.style.left=Math.min(b.width-230,Math.max(8,e.clientX-b.left+14))+'px';tip.style.top=Math.min(b.height-130,Math.max(8,e.clientY-b.top+14))+'px';tip.innerHTML=`<b>${{r.date}}</b><br/>Open: ${{r.open}}<br/>High: ${{r.high}}<br/>Low: ${{r.low}}<br/>Close: ${{r.close}}<br/>Volume: ${{r.volume||0}}`}});
addEventListener('resize',resize);resize();
</script>
</body>
</html>'''

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output-dir", default=os.environ.get("AGENT_UI_OUTPUT_DIR", "."))
    ap.add_argument("--run-id", default=os.environ.get("AGENT_UI_RUN_ID", ""))
    ap.add_argument("--title", default="")
    args = ap.parse_args()
    inp = Path(args.input).expanduser()
    if not inp.is_absolute():
        inp = Path.cwd() / inp
    inp = inp.resolve()
    outdir = Path(args.output_dir).expanduser()
    if not outdir.is_absolute():
        outdir = Path.cwd() / outdir
    outdir.mkdir(parents=True, exist_ok=True)
    rows, cols = read_rows(inp)
    run_id = args.run_id or time.strftime("%Y%m%d_%H%M%S")
    title = args.title or f"K-line Chart: {inp.name}"
    out = unique(outdir / (safe(f"kline-chart.kline_{inp.stem}_{run_id}") + ".html"))
    out.write_text(make_html(title, rows, cols), encoding="utf-8")
    print(f"Generated interactive K-line chart: {out}")

if __name__ == "__main__":
    main()
