#!/usr/bin/env python3
"""WCAG 2.x contrast check for the QColors tokens (docs/03-DESIGN_SYSTEM.md §2). Run: python3 tool/contrast.py"""
def L(h):
    h=h.lstrip('#'); c=[int(h[i:i+2],16)/255 for i in (0,2,4)]
    c=[x/12.92 if x<=0.03928 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def cr(a,b):
    x,y=sorted([L(a),L(b)],reverse=True); return (x+0.05)/(y+0.05)
dark=dict(bg='#07100F',s1='#0D1816',s2='#14221F',line='#22332F',ls='#56716A',text='#ECF3EF',text2='#AABBB5',text3='#879A93',halo='#F5C451',onHalo='#1C1500',ok='#7EDC8A',warn='#FF9F4A',bad='#FF6F80',info='#8FB4FF')
light=dict(bg='#F3F6F4',s1='#FFFFFF',s2='#E5ECE9',line='#D1DCD8',ls='#6C7F79',text='#0E1716',text2='#3C4B47',text3='#55645F',halo='#7A5900',onHalo='#FFFFFF',ok='#2D7333',warn='#9A4A00',bad='#B3263E',info='#2C52B5')
for n,p in (('dark',dark),('light',light)):
    print(n)
    for k in ('text','text2','text3','halo','ok','warn','bad','info','ls'):
        print(' ',k,[round(cr(p[k],p[s]),2) for s in ('bg','s1','s2')])
    print('  onHalo/halo',round(cr(p['onHalo'],p['halo']),2))
hues=dict(ceo='#B08CFF',sales='#3DB8FF',finance='#B9E25A',operations='#36CDBE',marketing='#F07AC0',research='#8EA2FF')
for k,v in hues.items(): print(k, round(cr(v,dark['bg']),2), 'vs light bg', round(cr(v,light['bg']),2))
