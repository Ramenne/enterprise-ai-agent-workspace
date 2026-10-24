"""Semantic endpoint input owner; MCP receives a structural projection only."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import uuid

QUERY_DEFAULTS = {"top_k": 10, "mode": "exact", "compare_exact": False, "include_historical": False}
QUERY_MODES = ("exact", "hnsw", "ivfflat")
QUERY_TEXT_BYTES = 32768
QUERY_TOP_K_MIN, QUERY_TOP_K_MAX = 1, 100
SHA_PATTERN = "^[0-9a-f]{64}$"
UUID_FIELD = {"type": "string", "format": "uuid"}
COMMON = {"project_id": UUID_FIELD, "source_context": {"type": "object"}}
FIXED_SCHEMA = {"type": "object", "properties": {
    "material_id": UUID_FIELD, "version_id": UUID_FIELD,
    "sha256": {"type": "string", "pattern": SHA_PATTERN}},
    "required": ["material_id", "version_id", "sha256"], "additionalProperties": False}
SCHEMAS = {
    "query": {"type": "object", "properties": {**COMMON,
        "text": {"type": "string", "minLength": 1, "maxLength": QUERY_TEXT_BYTES,
                 "x-utf8-max-bytes": QUERY_TEXT_BYTES, "description": "UTF-8 byte and model token budgets are checked by the domain."},
        "top_k": {"type": "integer", "minimum": QUERY_TOP_K_MIN, "maximum": QUERY_TOP_K_MAX, "default": QUERY_DEFAULTS["top_k"]},
        "mode": {"type": "string", "enum": list(QUERY_MODES), "default": QUERY_DEFAULTS["mode"]},
        "compare_exact": {"type": "boolean", "default": QUERY_DEFAULTS["compare_exact"]},
        "include_historical": {"type": "boolean", "default": QUERY_DEFAULTS["include_historical"]}},
        "required": ["project_id", "text"], "additionalProperties": False},
    "index": {"type": "object", "properties": {**COMMON, "fixed_ref": FIXED_SCHEMA},
        "required": ["project_id", "fixed_ref"], "additionalProperties": False}
}
PATHS = {"query": "/semantic/description-query", "index": "/semantic/description-index"}
OPERATIONS = {path: kind for kind, path in PATHS.items()}
OPERATIONS["/semantic/query"] = "query"  # Existing HTTP alias remains compatible.


class CandidateError(Exception):
    def __init__(self, code, status=400, detail=None):
        self.code, self.status, self.detail = code, status, detail or {}
        super().__init__(code)


def strict_object(value, allowed, required):
    if not isinstance(value, dict) or set(value) - set(allowed) or not set(required) <= set(value):
        raise CandidateError("invalid_input")


def check_uuid(value):
    try:
        uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise CandidateError("invalid_fixed_reference") from None


def query_option(body, name):
    return body.get(name, QUERY_DEFAULTS[name])


def validate(kind, body):
    if kind not in SCHEMAS:
        raise CandidateError("unknown_operation", 404)
    schema = SCHEMAS[kind]
    strict_object(body, schema["properties"], schema["required"])
    if kind == "query":
        if not isinstance(body["text"], str) or not body["text"].strip() or len(body["text"].encode()) > QUERY_TEXT_BYTES:
            raise CandidateError("query_text_budget_exceeded")
        top_k = query_option(body, "top_k")
        if isinstance(top_k, bool) or not isinstance(top_k, int) or not QUERY_TOP_K_MIN <= top_k <= QUERY_TOP_K_MAX:
            raise CandidateError("invalid_query_options")
        if query_option(body, "mode") not in QUERY_MODES or not isinstance(query_option(body, "compare_exact"), bool) or not isinstance(query_option(body, "include_historical"), bool):
            raise CandidateError("invalid_query_options")
    else:
        fixed = body["fixed_ref"]
        strict_object(fixed, FIXED_SCHEMA["properties"], FIXED_SCHEMA["required"])
        check_uuid(fixed["material_id"])
        check_uuid(fixed["version_id"])
        if not isinstance(fixed["sha256"], str) or not re.fullmatch(SHA_PATTERN, fixed["sha256"]):
            raise CandidateError("invalid_fixed_reference")
    check_uuid(body["project_id"])


def mcp_publication():
    def input_only(value):
        if isinstance(value, dict):
            return {key: input_only(item) for key, item in value.items() if key != "default"}
        if isinstance(value, list):
            return [input_only(item) for item in value]
        return value
    origin = {"owner": "semantic", "project_id": "fbe863aa-824f-4688-a24d-bc3398754704",
              "path": "packages/semantic-service/source/input_contracts.py",
              "sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "endpoint_key": "semantic", "projection": "structure-without-defaults;source-context-owned-by-protocol;domain-keeps-byte-and-UUID-checks"}
    contracts = []
    for kind, schema in SCHEMAS.items():
        schema = input_only(deepcopy(schema))
        del schema["properties"]["source_context"]
        contracts.append({"path": PATHS[kind], "input_schema": schema, "origin": origin})
    return {"origin": origin, "contracts": contracts}


if __name__ == "__main__":
    print(json.dumps(mcp_publication(), ensure_ascii=False, indent=2))
