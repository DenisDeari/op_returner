# Placeholder art: a message sitting inside a block of the chain. 120 x 170 units.
def art(bg1,bg2,block,stroke,lines,paper,dots,gid):
    grad=f'<linearGradient id="{gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{bg1}"/><stop offset="1" stop-color="{bg2}"/></linearGradient>'
    d=''.join(f'<circle cx="{x}" cy="{y}" r="{r}"/>' for x,y,r in [(14,20,.6),(30,44,.45),(98,14,.5),(108,40,.6),(22,128,.5),(100,140,.45),(88,160,.6),(12,156,.45),(40,10,.4),(84,36,.4)])
    def small(y):
        return (f'<rect x="49" y="{y}" width="22" height="22" rx="3" fill="{block}" stroke="{stroke}" stroke-width=".7"/>'
                + ''.join(f'<rect x="53" y="{y+5+i*4.2}" width="{w}" height="1.3" rx=".6" fill="{lines}"/>' for i,w in enumerate([14,10,12])))
    body=(f'<rect width="120" height="170" fill="url(#{gid})"/><g fill="{dots}">{d}</g>'
          f'<g stroke="{stroke}" stroke-width=".8" fill="none" stroke-linecap="round"><path d="M60 30 V52"/><path d="M60 116 V134"/><path d="M60 0 V8" opacity=".5"/><path d="M60 156 V170" opacity=".5"/></g>'
          + small(8) + small(134)
          + f'<rect x="10" y="52" width="100" height="64" rx="4" fill="{paper}" stroke="{stroke}" stroke-width=".8"/>'
          + f'<circle cx="103" cy="116" r="5.2" fill="{stroke}"/><text x="103" y="118.3" text-anchor="middle" font-size="6.4" fill="{paper}" font-family="Georgia,serif">₿</text>')
    return grad, body
VARIANTS={
 'm1':art('#111B31','#263A56','#1B2A44','#C8892E','#5C6E8E','#F4EFE6','#E9EEF5','ga1'),
 'm2':art('#7E8FA6','#EBC3A8','#5B6B80','#FFF3DF','#A9B6C6','#FBF6EE','#FFFFFF','ga2'),
 'm3':art('#EFE3CC','#E3CDA6','#B55B3A','#7C3E33','#E7B79B','#FFFDF8','#C9744A','ga3'),
}
