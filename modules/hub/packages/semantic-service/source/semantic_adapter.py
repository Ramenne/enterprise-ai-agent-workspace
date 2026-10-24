#!/usr/bin/env python3
"""Agent-maintained description-to-vector candidate; inherited BGE inference is offline.

Final public indexing/search goes to existing Mem endpoints and their guards.
This file does not install routes, select an actor, read a production database,
classify organization knowledge, or adopt a search candidate.
"""
import argparse
from dataclasses import dataclass, asdict
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request
import uuid
from input_contracts import QUERY_DEFAULTS, QUERY_MODES, QUERY_TOP_K_MIN, QUERY_TOP_K_MAX

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

BASE = Path(__file__).resolve().parent
DEFAULT_MODEL_DIR = BASE / "models" / "bge-small-zh-v1.5"
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value):
    return hashlib.sha256(value).hexdigest()


def file_sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


@dataclass(frozen=True)
class DescriptionPolicy:
    version: str = "agent-description-single-vector-v1"
    description_tokens: int = 448
    query_tokens: int = 448
    def __post_init__(self):
        if not 1 <= self.description_tokens <= 448 or not 1 <= self.query_tokens <= 448:
            raise ValueError("invalid_description_token_budget")


class SemanticAdapter:
    def __init__(self, model_dir=DEFAULT_MODEL_DIR, policy=DescriptionPolicy(), threads=2):
        import numpy as np
        import onnxruntime as ort
        import tokenizers
        self.np = np
        self.policy = policy
        self.model_dir = Path(model_dir)
        manifest = json.loads((BASE / "model-manifest.json").read_text())
        exported = json.loads((BASE / "export-result.json").read_text())
        by_name = {item["file"]: item for item in manifest["files"]}
        self.original_weights_present = (self.model_dir / "model.safetensors").exists()
        required_files = ("tokenizer.json", "config.json")
        if self.original_weights_present:
            required_files += ("model.safetensors",)
        for name in required_files:
            if file_sha(self.model_dir / name) != by_name[name]["sha256"]:
                raise ValueError("Pinned model file digest mismatch: " + name)
        model_path = self.model_dir / "model.onnx"
        if file_sha(model_path) != exported["exported_onnx_sha256"]:
            raise ValueError("Pinned ONNX model digest mismatch")
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(4, max(1, threads))
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(model_path), sess_options=options,
                                            providers=["CPUExecutionProvider"])
        self.tokenizer = tokenizers.Tokenizer.from_file(str(self.model_dir / "tokenizer.json"))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        config = json.loads((self.model_dir / "config.json").read_text())
        self.dimension = config["hidden_size"]
        if self.dimension != 512:
            raise ValueError("description_embedding_requires_512_dimensions")
        self.max_positions = config["max_position_embeddings"]
        self.recipe = {
            "name": "hub2-local-bge-zh-agent-description", "version": "description-v1",
            "parameters": {
                "repository": manifest["repository"], "weights_revision": manifest["revision"],
                "weights_sha256": by_name["model.safetensors"]["sha256"],
                "tokenizer_sha256": by_name["tokenizer.json"]["sha256"],
                "config_sha256": by_name["config.json"]["sha256"],
                "inference_artifact_sha256": exported["exported_onnx_sha256"],
                "pooling": "CLS", "normalize": "L2", "precision": "float32",
                "query_prefix": QUERY_PREFIX, "document_prefix": "",
                "description_policy": asdict(policy), "indexed_content": "Agent_maintained_description_only", "description_overflow": "needs_condense_no_truncation_no_chunks", "max_model_tokens": self.max_positions,
                "query_overflow": "explicit_error_no_truncation",
                "unicode_normalization": "none_preserve_original_utf8_offsets",
                "inference": {"engine": "onnxruntime", "version": ort.__version__,
                              "provider": "CPUExecutionProvider", "tokenizers": tokenizers.__version__},
            },
        }
        self.space = {"provider": "local-baai", "model": manifest["repository"],
                      "dimension": self.dimension, "recipe": self.recipe}
        # This is a local fingerprint, not PostgreSQL's JSONB-text space_key.
        self.local_space_fingerprint = sha(canonical(self.space).encode())
        self.last_inference = None

    def embed(self, texts, kind="document"):
        if kind not in ("document", "query") or not texts or len(texts) > 16:
            raise ValueError("Expected 1..16 texts and a query/document role")
        prefixed = []
        for text in texts:
            if not isinstance(text, str) or not text.strip():
                raise ValueError("empty_text_not_indexable")
            if kind == "query" and len(self.tokenizer.encode(text, add_special_tokens=False).ids) > self.policy.query_tokens:
                raise ValueError("query_exceeds_token_budget")
            prefixed.append((QUERY_PREFIX if kind == "query" else "") + text)
        encodings = self.tokenizer.encode_batch(prefixed)
        if any(len(item.ids) > self.max_positions for item in encodings):
            raise ValueError("model_token_limit_exceeded_no_truncation")
        width = max(len(item.ids) for item in encodings)
        feeds = {name: self.np.zeros((len(encodings), width), dtype=self.np.int64)
                 for name in ("input_ids", "attention_mask", "token_type_ids")}
        pad_id = self.tokenizer.token_to_id("[PAD]")
        if pad_id is None:
            raise ValueError("Pinned tokenizer has no PAD token")
        feeds["input_ids"].fill(pad_id)
        for row, encoding in enumerate(encodings):
            length = len(encoding.ids)
            feeds["input_ids"][row, :length] = encoding.ids
            feeds["attention_mask"][row, :length] = encoding.attention_mask
            feeds["token_type_ids"][row, :length] = encoding.type_ids
        started = time.perf_counter()
        hidden = self.session.run(["last_hidden_state"], feeds)[0]
        embeddings = hidden[:, 0, :].astype(self.np.float32)
        norms = self.np.linalg.norm(embeddings, axis=1, keepdims=True)
        if not self.np.isfinite(embeddings).all() or not (norms > 0).all():
            raise ValueError("model_produced_unrankable_embedding")
        result = embeddings / norms
        if result.shape != (len(texts), self.dimension):
            raise ValueError("dimension_mismatch")
        self.last_inference = {"duration_seconds": time.perf_counter() - started,
                               "batch": len(texts), "padded_tokens": width,
                               "provider": "CPUExecutionProvider", "kind": kind}
        return result

    def description_state(self, text):
        if not isinstance(text, str) or not text.strip():
            return "needs_agent_description"
        count = len(self.tokenizer.encode(text, add_special_tokens=False).ids)
        total = len(self.tokenizer.encode(text).ids)
        if count > self.policy.description_tokens or total > self.max_positions:
            return "needs_condense"
        return "ready"

    def embed_description(self, text):
        state = self.description_state(text)
        if state != "ready":
            return {"state": state, "embedding": None}
        # The complete description is one model input; no normalization, chunks,
        # truncation or generated substitute description is performed.
        return {"state": "ready", "embedding": self.embed([text], "document")[0].tolist()}

    def query_request(self, text, project_id, top_k=QUERY_DEFAULTS["top_k"], mode=QUERY_DEFAULTS["mode"], compare_exact=QUERY_DEFAULTS["compare_exact"], include_historical=QUERY_DEFAULTS["include_historical"]):
        uuid.UUID(project_id)
        if mode not in QUERY_MODES or not QUERY_TOP_K_MIN <= top_k <= QUERY_TOP_K_MAX:
            raise ValueError("invalid_query_options")
        vector = self.embed([text], "query")[0].tolist()
        return {"endpoint": "/v2/materials/description-vector-search", "body": {
            "project_id": project_id, "embedding": vector, "space": self.space,
            "top_k": top_k, "mode": mode, "compare_exact": compare_exact, "include_historical": include_historical},
            "semantic_status": "description_candidates_Agent_reads_fixed_document",
            "authority": "current_caller_current_source_context_Mem_guard"}
