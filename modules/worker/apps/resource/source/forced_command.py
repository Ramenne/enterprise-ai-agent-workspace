#!/usr/bin/env python3
"""SSH transport executes only resource-v1; credentials arrive via stdin, never argv."""
import json, os, sys, signal
from resource_executor import Executor, OnlineAuthority, Rejected

def main():
    os.umask(0o077)
    signal.alarm(10)
    if os.environ.get('SSH_ORIGINAL_COMMAND') != 'resource-v1':
        raise Rejected('arbitrary_shell_denied')
    config_path = os.environ.get('HUB2_RESOURCE_CONFIG') or '/etc/hub2-resource/executor.json'
    with open(config_path) as stream: config = json.load(stream)
    with open(config['service_key_file']) as stream: service_key = stream.read().strip()
    raw = sys.stdin.buffer.read(3*1024*1024 + 1)
    if len(raw) > 3*1024*1024: raise Rejected('request_limit', 413)
    call = json.loads(raw)
    if set(call) != {'bearer', 'request'} or not isinstance(call['bearer'], str):
        raise Rejected('invalid_request', 400)
    authority = OnlineAuthority(config['authority_url'], service_key, config['endpoint_id'])
    executor = Executor(config['areas'], config['journal'], authority)
    try: return executor.execute(call['bearer'], call['request'])
    finally: executor.close()
if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Rejected as error:
        print(json.dumps({'state':'rejected','error_code':error.code,'status':error.status,**({'accepted_receipt':error.receipt} if error.receipt else {})})); sys.exit(1)
    except (OSError, ValueError, KeyError):
        print(json.dumps({'state':'failed','error_code':'execution_unavailable','status':503})); sys.exit(1)
