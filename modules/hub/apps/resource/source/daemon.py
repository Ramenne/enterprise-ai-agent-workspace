#!/usr/bin/env python3
"""Loopback nonroot transport. Caller identity stays with current Hufu checks."""
import argparse, hmac, json, os, stat, threading, sqlite3
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from resource_executor import Executor, OnlineAuthority, Rejected

def controlled_json(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0,os.geteuid()) or info.st_mode&0o022 or info.st_size>1024*1024:
            raise ValueError('unsafe_resource_configuration')
        return json.load(stream)

def serve(config_path,port):
    if os.geteuid()==0:raise ValueError('independent_nonroot_executor_required')
    os.umask(0o077)
    config=controlled_json(config_path)
    fd=os.open(config['service_key_file'],os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0,os.geteuid()) or info.st_mode&0o027 or info.st_size>65536:
            raise ValueError('unsafe_resource_check_key')
        machine=stream.read().strip()
    if len(machine)<32:raise ValueError('resource_check_key_required')
    authority=OnlineAuthority(config['authority_url'],machine,config['endpoint_id'])
    probe=Executor(config['areas'],config['journal'],authority);probe.close()
    capacity=threading.BoundedSemaphore(8)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass # Never credentials, private bytes or raw paths.
        def respond(self,status,data):
            body=json.dumps(data,ensure_ascii=False).encode();self.send_response(status)
            self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store')
            self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_GET(self):
            if self.path!='/ready':return self.respond(404,{'state':'not_found'})
            self.respond(200,{'state':'ready','coverage':'configured_loopback_transport;current_authority_checked_per_operation'})
        def do_POST(self):
            executor=None
            admitted=capacity.acquire(blocking=False)
            if not admitted:return self.respond(503,{'state':'busy','error_code':'executor_capacity','retryable':True})
            try:
                if self.path!='/execute':raise Rejected('not_found',404)
                if not hmac.compare_digest(self.headers.get('X-Hub-Resource-Key',''),machine):raise Rejected('untrusted_relay')
                bearer=self.headers.get('Authorization','')
                if not bearer.startswith('Bearer ') or len(bearer)>4096:raise Rejected('unauthenticated',401)
                if self.headers.get('Transfer-Encoding'):raise Rejected('invalid_request',400)
                length=int(self.headers.get('Content-Length','-1'))
                if length<0 or length>3*1024*1024:raise Rejected('request_limit',413)
                self.connection.settimeout(15)
                raw=self.rfile.read(length)
                if len(raw)!=length:raise Rejected('request_incomplete',400)
                request=json.loads(raw)
                executor=Executor(config['areas'],config['journal'],authority)
                result=executor.execute(bearer[7:],request)
                self.respond(200,result)
            except Rejected as error:
                self.respond(error.status,{'state':'rejected','error_code':error.code,
                  **({'accepted_receipt':error.receipt}if error.receipt else {})})
            except (OSError,ValueError,KeyError,TypeError,sqlite3.Error):
                self.respond(503,{'state':'failed','error_code':'execution_unavailable','retryable':True})
            finally:
                if executor:executor.close()
                capacity.release()
    class Server(ThreadingHTTPServer):
        daemon_threads=True
        request_queue_size=16
    Server(('127.0.0.1',port),Handler).serve_forever()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--port',type=int,default=4617)
    args=parser.parse_args();serve(args.config,args.port)
