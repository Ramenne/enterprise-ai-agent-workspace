#!/usr/bin/env python3
"""Collect authorized local Codex text into SQLite; never judge knowledge value.

Only messages and explicit delegation prompts are copied. Original files stay
unchanged. Tool output, reasoning, automatic context and summaries remain
distinguishable. The caller supplies exact paths, not a global home scan.
"""
import argparse, collections, contextlib, hashlib, json, pathlib, re, sqlite3, subprocess

SCHEMA = '''
CREATE TABLE IF NOT EXISTS sources(
 session_id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL,
 parent_id TEXT, bytes_observed INTEGER, lines_observed INTEGER,
 collection_coverage TEXT, metrics_json TEXT);
CREATE TABLE IF NOT EXISTS messages(
 session_id TEXT NOT NULL, message_id TEXT NOT NULL, timestamp TEXT,
 source_line INTEGER, role TEXT, kind TEXT NOT NULL, phase TEXT,
 text TEXT NOT NULL, redacted INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(session_id,message_id));
CREATE INDEX IF NOT EXISTS messages_order ON messages(session_id,source_line);
CREATE TABLE IF NOT EXISTS information_candidates(
 candidate_id TEXT PRIMARY KEY, session_id TEXT, payload_json TEXT NOT NULL,
 decision TEXT NOT NULL DEFAULT 'unreviewed', reason TEXT);
'''

def clean(text, otp_expected=False):
    original=text
    if otp_expected and re.fullmatch(r"\s*\d{4,8}\s*", text):
        return "[验证码已脱敏]", True
    text=re.sub(r'<in-app-browser-context\b[^>]*>.*?</in-app-browser-context>', '', text, flags=re.S)
    text=re.sub(r'<oai-mem-citation>.*?</oai-mem-citation>', '', text, flags=re.S)
    if '验证码' in text:
        text=re.sub(r'("answer"\s*:\s*")\d{4,8}("\s*})',r'\1[验证码已脱敏]\2',text)
        text=re.sub(r'(验证码\s*[:：=]\s*)\d{4,8}',r'\1[验证码已脱敏]',text)
    text=re.sub(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----','[私钥已脱敏]',text,flags=re.S)
    text=re.sub(r'\bBearer\s+[A-Za-z0-9._~+/=-]{24,}', 'Bearer [凭据已脱敏]',text)
    text=re.sub(r'\bsk-[A-Za-z0-9_-]{20,}', '[密钥已脱敏]',text)
    text=re.sub(r'((?:密码|口令)\s*(?:(?:就)?是|为|[:：=]))\s*[^"\n，。；;]{1,100}',
                r'\1[凭据已脱敏]', text)
    # Adjacent ASCII credentials occur without an assignment word or colon.
    text=re.sub(r'((?:密码|口令)\s*)([A-Za-z0-9][A-Za-z0-9!@#$%^&*()_+={}\[\]:;,.?/|~`<>\\-]{3,99})',
                r'\1[凭据已脱敏]', text)
    return text.strip(), ('已脱敏]' in text and text!=original)

@contextlib.contextmanager
def source_text(path):
    """Stream plain or zstd-archived JSONL without writing decompressed logs."""
    if path.suffix != '.zst':
        with path.open() as stream:
            yield stream
        return
    with subprocess.Popen(['zstd', '-dc', '--', str(path)], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, encoding='utf-8') as proc:
        try:
            yield proc.stdout
        except BaseException:
            proc.kill()
            raise
        finally:
            proc.stdout.close()
        error = proc.stderr.read()
        if proc.wait() != 0:
            raise RuntimeError('zstd decompression failed: ' + error.strip())

def collect(path, title, db):
    p=pathlib.Path(path);rows=[];meta={};turn_id=None;metrics=collections.Counter();n=0;otp_expected=False
    with source_text(p) as stream:
        for n,line in enumerate(stream,1):
            try:d=json.loads(line)
            except json.JSONDecodeError:metrics['invalid_json_lines']+=1;continue
            x=d.get('payload',{});typ=d.get('type');timestamp=d.get('timestamp')
            if typ=='session_meta':meta=x;continue
            if typ=='event_msg' and x.get('type')=='task_started':turn_id=x.get('turn_id')
            if typ=='compacted':metrics['compactions']+=1
            if typ!='response_item':continue
            role=x.get('role');kind=None;text=''
            if x.get('type')=='message' and role in ['user','assistant']:
                text='\n'.join(z.get('text','') for z in x.get('content',[]) if isinstance(z,dict) and z.get('text'))
                if not text.strip():continue
                if role=='user' and text.startswith(('# AGENTS.md instructions','<environment_context>','<external_codex_apps_open_page>','<codex_internal_context','<recommended_plugins>')):
                    metrics['automatic_context_skipped']+=1;continue
                kind='human_message' if role=='user' else 'assistant_message'
                if role=='assistant' and text.startswith(('## 当前任务','## 当前状态','## Active task','## Pending user request','## Current task')):kind='continuation_summary'
                if role=='assistant' and len(text)>6000 and text.splitlines()[0] in ('## Goal and scope', '## Active goal and scope', '## Goal and current status', '## Task and latest steering', '## Active goal and latest user steering', '## Current state', '## 最新指令与本轮停止线'):kind='continuation_summary'
                if role=='user' and text.startswith('<codex_delegation>'):kind='delegated_prompt'
            elif x.get('type')=='function_call_output' and '<codex_delegation>' in str(x.get('output','')):
                role='agent';kind='delegated_prompt';text=x['output']
            if not kind:continue
            raw_text=text
            text,redacted=clean(text, otp_expected=otp_expected and role=="user")
            if role=="assistant":
                otp_expected="验证码" in raw_text
            elif role=="user":
                otp_expected="验证码" in raw_text or (otp_expected and re.fullmatch(r"\s*\d{4,8}\s*", raw_text) is not None)
            if not text:continue
            mid=x.get('id') or hashlib.sha256((str(n)+'\n'+text).encode()).hexdigest()
            rows.append((mid,timestamp,n,role,kind,x.get('phase'),text,int(redacted)))
            metrics[kind]+=1;metrics['text_chars']+=len(text);metrics['redacted_messages']+=int(redacted)
    sid=meta.get('id') or meta.get('session_id') or p.stem
    with db:
        db.execute('DELETE FROM messages WHERE session_id=?',(sid,))
        db.executemany('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)',[(sid,*r) for r in rows])
        db.execute('INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?,?,?)',(sid,str(p),title,meta.get('forked_from_id'),p.stat().st_size,n,'all_matching_records_to_observed_end;not_all_attachments_or_inherited_history',json.dumps(metrics,ensure_ascii=False)))
    return {'session_id':sid,'title':title,'metrics':dict(metrics),'lines_observed':n}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--db',required=True);ap.add_argument('--manifest',required=True)
    args=ap.parse_args();pathlib.Path(args.db).parent.mkdir(parents=True,exist_ok=True)
    manifest=json.loads(pathlib.Path(args.manifest).read_text());db=sqlite3.connect(args.db);db.executescript(SCHEMA)
    for r in manifest:
        for f in r.get('files',[]):print(json.dumps(collect(f['path'],r['title'],db),ensure_ascii=False))
    db.close()

if __name__=='__main__':main()
