#!/usr/bin/env python3
"""Compare every client .rpc('name', {keys}) call against pg_proc arg names.

Usage: python3 check_rpc_params.py [dbname]   (default: $DB or gbig_ci)
Connects with the libpq env (PGHOST / PGPORT / PGUSER / PGPASSWORD); run it
against a database that run_all.sh / run_migrations.sh has migrated.
Exits 1 if any call names an unknown function or mismatched arguments.
"""
import os, re, subprocess, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[3]
DB = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('DB', 'gbig_ci')
env = {**os.environ, 'PGUSER': os.environ.get('PGUSER', 'postgres')}
proc = subprocess.run(['psql', '-d', DB, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c',
  "select proname, coalesce(array_to_string(proargnames[1:pronargs],','),''), pronargdefaults from pg_proc where pronamespace='public'::regnamespace"],
  capture_output=True, text=True, env=env)
if proc.returncode != 0:
    print(proc.stderr.strip() or 'psql failed', file=sys.stderr)
    sys.exit(2)
funcs = {}
for line in proc.stdout.strip().splitlines():
    n, a, d = line.split('|'); funcs.setdefault(n, []).append((a.split(',') if a else [], int(d)))
problems = 0
calls = 0
for f in sorted(list(ROOT.glob('src/**/*.js*')) + list(ROOT.glob('supabase/functions/**/*.ts'))):
    if 'test' in f.name: continue
    src = f.read_text()
    for m in re.finditer(r"\.rpc\('([a-z_0-9]+)'\s*(,\s*\{)?", src):
        name, keys = m.group(1), []
        if m.group(2):
            i, depth, start = m.end(), 1, m.end()
            while depth:
                c = src[i]; depth += (c == '{') - (c == '}'); i += 1
            body = src[start:i-1]
            # top-level keys only
            d = 0; buf = ''
            for c in body:
                if c in '{[(': d += 1
                if c in '}])': d -= 1
                buf += c if d == 0 else ('' if c not in '{[(' else '')
            keys = re.findall(r'\b(p_[a-z_0-9]+)\s*:', buf)
        line = src[:m.start()].count('\n') + 1
        calls += 1
        ok = False
        for args, ndef in funcs.get(name, []):
            required = args[:len(args)-ndef]
            if set(keys) <= set(args) and set(required) <= set(keys): ok = True
        status = 'OK ' if ok else 'BAD'
        if not ok: problems += 1
        print(f"{status} {f.relative_to(ROOT)}:{line} {name}({', '.join(keys)}) vs {funcs.get(name)}")
print(f'calls: {calls}, problems: {problems}')
sys.exit(1 if problems else 0)
