#!/usr/bin/env python3
"""Warm CPU semantic candidate. Caller credentials are forwarded per request.

Index input is a fixed document reference. Only its Agent-maintained description
is read; this default runtime has no whole-document read/index route.
The model is initialized/hash-checked once; one inference worker and a bounded
queue serve compound operations. This installs no formal route or MCP plugin.
"""
import argparse
import base64
from concurrent.futures import Future, TimeoutError as FutureTimeout
from dataclasses import dataclass
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from semantic_adapter import BASE, DEFAULT_MODEL_DIR, SemanticAdapter, canonical, sha
from input_contracts import CandidateError, strict_object, check_uuid, validate, query_option, OPERATIONS

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def source_header(body, header):
    if "source_context" in body and header:
        raise CandidateError("ambiguous_source_context")
    if "source_context" in body:
        if not isinstance(body["source_context"], dict):
            raise CandidateError("invalid_source_context")
        header = base64.urlsafe_b64encode(canonical(body["source_context"]).encode()).decode().rstrip("=")
    if header and (len(header) > 8192 or not re.fullmatch(r"[A-Za-z0-9_-]+", header)):
        raise CandidateError("invalid_source_context")
    return header


@dataclass
class RequestContext:
    token: str
    source: str | None
    deadline: float


class MemForwarder:
    """No global credential, redirects, private-text logs, or arbitrary URL input."""
    def __init__(self, base_url, timeout=10):
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("invalid_mem_endpoint")
        if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("non_loopback_mem_requires_https")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        self.opener = urllib.request.build_opener(NoRedirect())

    def post(self, endpoint, body, context):
        if endpoint not in ("/v2/materials/head", "/v2/materials/description-read", "/v2/materials/description-vector-index", "/v2/materials/description-vector-search"):
            raise CandidateError("unsupported_upstream_endpoint", 500)
        remaining = context.deadline - time.monotonic()
        if remaining <= 0:
            raise CandidateError("request_deadline_exceeded", 503)
        headers = {"content-type": "application/json", "authorization": "Bearer " + context.token}
        if context.source:
            headers["x-hub-source-context"] = context.source
        request = urllib.request.Request(self.base_url + endpoint, data=canonical(body).encode(),
                                         headers=headers, method="POST")
        try:
            with self.opener.open(request, timeout=min(self.timeout, remaining)) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise CandidateError("upstream_response_budget_exceeded", 502)
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise CandidateError("invalid_upstream_response", 502)
                return result
        except urllib.error.HTTPError as exc:
            # Do not copy arbitrary upstream error text/body into logs/results.
            if exc.code in (401, 403):
                raise CandidateError("current_caller_not_authorized", exc.code) from None
            if exc.code == 409:
                raise CandidateError("description_or_document_changed", 409, {"retry_fetch_current_description": True}) from None
            raise CandidateError("upstream_request_rejected", 502, {"upstream_status": exc.code}) from None
        except (urllib.error.URLError, TimeoutError):
            raise CandidateError("upstream_unavailable", 503) from None
        except (ValueError, UnicodeDecodeError):
            raise CandidateError("invalid_upstream_response", 502) from None


class WarmEngine:
    def __init__(self, mem_url, model_dir=DEFAULT_MODEL_DIR, queue_size=4, adapter=None):
        if not 1 <= queue_size <= 16:
            raise ValueError("candidate_queue_budget_invalid")
        self.adapter = adapter or SemanticAdapter(model_dir=model_dir, threads=2)
        self.mem = MemForwarder(mem_url)
        self.pending = queue.Queue(maxsize=queue_size)
        self.closed = False
        self.worker = threading.Thread(target=self._work, daemon=True, name="semantic-single-worker")
        self.worker.start()

    def submit(self, kind, body, context):
        if self.closed:
            raise CandidateError("candidate_stopping", 503)
        self.validate(kind, body)
        future = Future()
        job = {"kind": kind, "body": body, "context": context, "future": future}
        try:
            self.pending.put_nowait(job)
        except queue.Full:
            raise CandidateError("semantic_queue_full", 503, {"retryable": True}) from None
        return future

    def validate(self, kind, body):
        validate(kind, body)

    def _work(self):
        while True:
            job = self.pending.get()
            if job is None:
                self.pending.task_done()
                return
            future = job["future"]
            context = job["context"]
            try:
                if not future.set_running_or_notify_cancel():
                    continue
                if context.deadline <= time.monotonic():
                    raise CandidateError("queue_deadline_exceeded", 503)
                started = time.perf_counter()
                result = self._query(job["body"], context) if job["kind"] == "query" else self._index(job["body"], context)
                result["candidate_operation_seconds"] = time.perf_counter() - started
                future.set_result(result)
            except CandidateError as exc:
                future.set_exception(exc)
            except ValueError as exc:
                code = str(exc)
                if code not in {"query_exceeds_token_budget", "model_token_limit_exceeded_no_truncation", "empty_text_not_indexable"}:
                    code = "candidate_input_or_model_error"
                future.set_exception(CandidateError(code))
            except Exception:
                future.set_exception(CandidateError("candidate_internal_error", 500))
            finally:
                # Per-request token/body live only for the pending/running job.
                context.token = ""
                context.source = None
                job["body"] = None
                job["context"] = None
                self.pending.task_done()

    def _query(self, body, context):
        request = self.adapter.query_request(body["text"], body["project_id"], query_option(body, "top_k"),
                                             query_option(body, "mode"), query_option(body, "compare_exact"), query_option(body, "include_historical"))
        result = self.mem.post(request["endpoint"], request["body"], context)
        return {"state": "queried_candidates", "receipt": result, "auto_adopted": False,
                "authorization": "current_caller_and_source_forwarded_per_request",
                "retrieval_unit": "Agent_description_linked_to_fixed_document", "legacy_fulltext_fallback": False}

    def _index(self, body, context):
        fixed = body["fixed_ref"]
        head = self.mem.post("/v2/materials/head", {
            "project_id": body["project_id"], "material_id": fixed["material_id"]}, context)
        if (head.get("properties") or {}).get("governance", {}).get("importance_level") not in (1, 2):
            return {"state": "not_indexed", "reason": "importance_level_1_or_2_required",
                    "fixed_ref": fixed, "indexed_descriptions": 0,
                    "original_readability_unchanged": True, "auto_adopted": False}
        current = self.mem.post("/v2/materials/description-read", {
            "project_id": body["project_id"], **fixed}, context)
        actual = current.get("fixed_ref")
        if not isinstance(actual, dict) or any(actual.get(key) != fixed[key] for key in ("material_id", "version_id", "sha256")):
            raise CandidateError("fixed_reference_changed", 409)
        common = {"fixed_ref": fixed, "original_readability_unchanged": True,
                  "auto_adopted": False, "indexed_descriptions": 0,
                  "authorization": "current_caller_and_source_forwarded_per_request",
                  "legacy_fulltext_fallback": False}
        state = current.get("state")
        if state in ("needs_agent_description", "needs_condense"):
            # Saving a file or a long description is independent of indexing.
            return {**common, "state": state, "description": {key: value for key, value in (current.get("description") or {}).items() if key in ("revision", "text_sha256")} if isinstance(current.get("description"), dict) else None,
                    "description_saved_unchanged": True,
                    "next_step": "Agent_writes_description" if state == "needs_agent_description" else "Agent_condenses_saved_description"}
        description = current.get("description")
        if state != "ready" or not isinstance(description, dict):
            raise CandidateError("invalid_upstream_description", 502)
        revision = description.get("revision")
        text = description.get("text")
        text_sha = description.get("text_sha256")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1 or not isinstance(text, str):
            raise CandidateError("invalid_upstream_description", 502)
        if not isinstance(text_sha, str) or not re.fullmatch("[0-9a-f]{64}", text_sha) or sha(text.encode()) != text_sha:
            raise CandidateError("description_integrity_mismatch", 409)
        embedded = self.adapter.embed_description(text)
        if embedded["state"] != "ready":
            return {**common, "state": embedded["state"], "description_revision": revision,
                    "description_sha256": text_sha, "description_saved_unchanged": True,
                    "next_step": "Agent_condenses_saved_description" if embedded["state"] == "needs_condense" else "Agent_writes_description"}
        key = sha(canonical({"project_id": body["project_id"], "fixed": fixed,
                             "description_revision": revision, "description_sha256": text_sha,
                             "space": self.adapter.space}).encode())
        receipt = self.mem.post("/v2/materials/description-vector-index", {
            "project_id": body["project_id"], **fixed,
            "description_revision": revision, "description_sha256": text_sha,
            "embedding": embedded["embedding"], "space": self.adapter.space,
            "idempotency_key": "description-" + key}, context)
        if receipt.get("state") != "indexed":
            return {**common, "state": receipt.get("state", "not_indexed"),
                    "indexed_descriptions": 0, "receipt": receipt,
                    "next_step": "Agent_classifies_level_1_or_2_before_indexing"}
        return {**common, "state": "description_indexed", "indexed_descriptions": 1,
                "description_revision": revision, "description_sha256": text_sha,
                "embedding_dimension": self.adapter.dimension, "receipt": receipt}

    def close(self):
        self.closed = True
        self.pending.put(None)
        self.worker.join(timeout=30)


class BoundedServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16
    def __init__(self, address, engine):
        self.engine = engine
        self.connections = threading.BoundedSemaphore(8)
        super().__init__(address, Handler)
    def process_request(self, request, address):
        if not self.connections.acquire(blocking=False):
            raw = b'{"state":"busy","error_code":"connection_limit","retryable":true}'
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: " + str(len(raw)).encode() + b"\r\n\r\n" + raw)
            finally:
                self.shutdown_request(request)
            return
        super().process_request(request, address)
    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.connections.release()
    def handle_error(self, request, client_address):
        pass  # Never print tracebacks containing request headers/body.


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, format, *args):
        pass
    def setup(self):
        super().setup()
        self.connection.settimeout(35)
    def send_json(self, status, value):
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        if status == 503:
            self.send_header("Retry-After", "1")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True
    def do_GET(self):
        if self.path != "/health":
            return self.send_json(404, {"error_code": "unknown_operation"})
        self.send_json(200, {"state": "warm_ready", "model": self.server.engine.adapter.space["model"],
                             "dimension": self.server.engine.adapter.dimension, "inference_workers": 1,
                             "cpu_threads": 2, "queue_capacity": self.server.engine.pending.maxsize,
                             "retrieval_unit": "Agent_description", "legacy_fulltext_fallback": False})
    def do_POST(self):
        context = None
        try:
            if self.path == "/semantic/index":
                raise CandidateError("legacy_fulltext_index_disabled", 410)
            kind = OPERATIONS.get(self.path)
            if not kind:
                raise CandidateError("unknown_operation", 404)
            bearer = self.headers.get("Authorization", "")
            if not bearer.startswith("Bearer ") or not bearer[7:] or len(bearer) > 16384:
                raise CandidateError("current_caller_credential_required", 401)
            if self.headers.get("Transfer-Encoding"):
                raise CandidateError("unsupported_request_framing")
            length = int(self.headers.get("Content-Length", "0"))
            if not 1 <= length <= 65536:
                raise CandidateError("request_body_budget_exceeded", 413)
            body = json.loads(self.rfile.read(length))
            source = source_header(body, self.headers.get("x-hub-source-context"))
            context = RequestContext(bearer[7:], source, time.monotonic() + 30)
            future = self.server.engine.submit(kind, body, context)
            result = future.result(timeout=31)
            self.send_json(200, result)
        except CandidateError as exc:
            self.send_json(exc.status, {"state": "rejected", "error_code": exc.code, **exc.detail})
        except FutureTimeout:
            self.send_json(503, {"state": "pending_or_failed", "error_code": "request_deadline_exceeded",
                                 "retry_same_fixed_ref_and_recipe": True})
        except (ValueError, TypeError, UnicodeDecodeError):
            self.send_json(400, {"state": "rejected", "error_code": "invalid_input"})
        except Exception:
            self.send_json(500, {"state": "rejected", "error_code": "candidate_internal_error"})
        finally:
            # A running job owns its context until completion; no global token.
            if context and not context.token:
                context.source = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mem-url", required=True)
    parser.add_argument("--host", default="127.0.0.1", choices=("127.0.0.1",))
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--queue-size", type=int, default=4)
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR))
    args = parser.parse_args()
    engine = WarmEngine(args.mem_url, model_dir=args.model_dir, queue_size=args.queue_size)
    server = BoundedServer((args.host, args.port), engine)
    print(json.dumps({"state": "warm_ready", "model": engine.adapter.space["model"],
                      "dimension": engine.adapter.dimension, "cpu_threads": 2}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        engine.close()


if __name__ == "__main__":
    main()
