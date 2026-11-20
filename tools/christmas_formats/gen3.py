from art import VARIANTS
grad,body=VARIANTS['m1']
defs=f'''<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>{grad}
<pattern id="hatch" width="2.4" height="2.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="2.4" stroke="#B4532A" stroke-width=".55"/></pattern>
</defs></svg>'''
card='<rect x="0" y="0" width="148" height="210" fill="#FBF8F2" stroke="#CFC6B4" stroke-width=".35"/>'
painting=f'<g transform="translate(14 14)"><svg width="120" height="169.7" viewBox="0 0 120 170" preserveAspectRatio="none">{body}</svg></g>'
cap='<text x="74" y="198" text-anchor="middle" font-size="3.4" font-style="italic" fill="#5E5B52" class="t-serif">Titel · gemalt von …</text>'
def dim_h(x1,x2,y,label):
    m=(x1+x2)/2
    return (f'<g stroke="#8A8577" stroke-width=".3"><line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}"/><line x1="{x1}" y1="{y-1.6}" x2="{x1}" y2="{y+1.6}"/><line x1="{x2}" y1="{y-1.6}" x2="{x2}" y2="{y+1.6}"/></g>'
            f'<text x="{m}" y="{y-1.8}" text-anchor="middle" font-size="3.6" fill="#6B6A62" class="t-sans">{label}</text>')
def dim_v(y1,y2,x,label):
    m=(y1+y2)/2
    return (f'<g stroke="#8A8577" stroke-width=".3"><line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}"/><line x1="{x-1.6}" y1="{y1}" x2="{x+1.6}" y2="{y1}"/><line x1="{x-1.6}" y1="{y2}" x2="{x+1.6}" y2="{y2}"/></g>'
            f'<text x="{x+2.4}" y="{m+1.2}" font-size="3.6" fill="#6B6A62" class="t-sans">{label}</text>')
WX,WY,WW,WH,S=14,14,120,169.7,6
zone=(f'<path d="M{WX} {WY}h{WW}v{WH}h-{WW}z M{WX+S} {WY+S}v{WH-2*S}h{WW-2*S}v-{WH-2*S}z" fill="url(#hatch)" fill-rule="evenodd" opacity=".9"/>'
      f'<rect x="{WX}" y="{WY}" width="{WW}" height="{WH}" fill="none" stroke="#1F2A24" stroke-width=".3"/>')
MX,MY,MW,MH=24,68,100,60
field=(f'<rect x="{MX}" y="{MY}" width="{MW}" height="{MH}" fill="#fff" fill-opacity=".6" stroke="#1F2A24" stroke-width=".5" stroke-dasharray="1.8 1.2"/>'
       f'<text x="74" y="{MY+MH/2-1}" text-anchor="middle" font-size="5" font-weight="600" fill="#1F2A24" class="t-sans">Nachricht</text>'
       f'<text x="74" y="{MY+MH/2+5.5}" text-anchor="middle" font-size="4.2" fill="#1F2A24" class="t-sans">ca. 100 × 60</text>')
dims=(dim_h(0,148,-7,"148")+dim_v(0,210,-12,"")+'<text x="-15" y="105" font-size="3.6" fill="#6B6A62" text-anchor="middle" transform="rotate(-90 -15 105)" class="t-sans">210</text>'
      +dim_v(14,183.7,154,"170")+dim_h(14,134,220,"120"))
serif='class="t-serif" fill="#1F2A24" text-anchor="middle"'
ITAL='font-style="italic" '
lines=[("Lieber Max,",1),("",0),("frohe Weihnachten! Ein kleines Stück",0),("Bitcoin von mir. Diese Zeilen bleiben",0),("für immer in der Blockchain.",0),("",0),("Dein Bruder",1)]
msg=''.join('<text x="74" y="%.1f" font-size="3.9" %s%s>%s</text>' % (81+i*5.6, ITAL if it else '', serif, t) for i,(t,it) in enumerate(lines) if t)
html=f'''<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Kartenformat</title>
<style>
:root{{--serif:Georgia,serif;--sans:-apple-system,"Segoe UI",system-ui,Helvetica,Arial,sans-serif}}
body{{margin:0;background:#fff;color:#222;font:17px/1.5 var(--sans)}}
.wrap{{max-width:760px;margin:0 auto;padding:24px 16px 48px}}
h1{{font-size:22px;margin:0 0 16px}}
.cards{{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:end}}
.cards svg{{width:100%;height:auto;display:block}}
.cards p{{margin:6px 0 0;font-size:14px;color:#666;text-align:center}}
ul{{margin:24px 0 0;padding-left:20px}}
li{{margin:6px 0}}
svg .t-serif{{font-family:var(--serif)}} svg .t-sans{{font-family:var(--sans)}}
</style>
</head>
<body>
{defs}
<div class="wrap">
  <h1>Kartenformat</h1>
  <div class="cards">
    <div><svg viewBox="-24 -16 196 248" role="img" aria-label="Maße">{card}{painting}{zone}{field}{cap}{dims}</svg><p>Maße (mm)</p></div>
    <div><svg viewBox="-24 -16 196 248" role="img" aria-label="Beispiel">{card}{painting}{msg}{cap}</svg><p>Beispiel (Platzhalter)</p></div>
  </div>
  <ul>
    <li>Bild: <b>120 × 170 mm</b>, hochkant (Verhältnis wie A4/A3)</li>
    <li>Thema: eine Nachricht, für immer in der Bitcoin-Blockchain</li>
    <li>Die Nachricht steht auf dem Bild. Dafür eine ruhige Fläche von etwa <b>100 × 60 mm</b> (auf A4 gemalt: 17,5 × 10,5 cm). Wo sie liegt, entscheidest du.</li>
    <li>Schraffierter Rand: nichts Wichtiges</li>
    <li>Scan: 600 dpi</li>
  </ul>
</div>
</body>
</html>
'''
open('formats.html','w').write(html)
