import re

s = open('webapp/index.html', encoding='utf-8').read()
m = re.search(r'<script type="module">(.*?)</script>', s, re.S)
assert m, 'module script not found'
open('_check_ui.mjs', 'w', encoding='utf-8').write(m.group(1))
print('extracted', len(m.group(1)), 'chars')
