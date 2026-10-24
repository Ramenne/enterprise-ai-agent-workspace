import base64
import hashlib
import json
import uuid

import httpx2 as httpx
import pytest

from tools_mcp.config import Settings
from tools_mcp.connector import Connector, schema


class FakeTools:
    def __init__(self):
        self.calls = []
        self.documents = {}
        self.receipts = {}
        self.writes = 0
        self.revoked = False
        self.allow_writes = True
        self.lose_response = False
        self.pending = False
        text = {"type": "string"}
        self.operations = [
            {"name": "identity", "inputSchema": schema()},
            {"name": "knowledge_save", "write": True, "inputSchema": schema({**{k: text for k in ["id", "projectId", "projectName", "title", "body", "sourceName", "sourceUrl", "category", "summary", "tags", "scope", "limitations", "evidence", "status", "reportHref", "reportTitle", "skillId", "skillTitle"]}, "revision": {"type": "integer", "minimum": 1}}, ["projectId", "title", "body"])},
            {"name": "knowledge_read", "inputSchema": schema({"id": text, "version": {"type": "integer"}}, ["id"])},
            {"name": "html_save", "write": True, "inputSchema": schema({k: text for k in ["projectId", "projectTitle", "filename", "path", "title", "content", "kind"]}, ["projectId", "content"])},
            {"name": "html_read", "inputSchema": schema({"projectId": text, "id": text}, ["projectId", "id"])},
            {"name": "skill_import", "write": True, "inputSchema": schema({k: text for k in ["filename", "packageBase64", "title"]}, ["filename", "packageBase64"])},
            {"name": "skill_read", "inputSchema": schema({"id": text, "version": {"type": "integer"}}, ["id"])},
            {"name": "account_password_read", "agentAvailable": True, "inputSchema": schema()},
            {"name": "private_operation", "sensitive": True, "inputSchema": schema()},
            {"name": "direct_only", "agentAvailable": False, "inputSchema": schema()},
        ]

    @staticmethod
    def reply(data, status=200):
        return httpx.Response(status, json=data)

    async def handle(self, request):
        self.calls.append(request)
        token = request.headers.get("Authorization", "").removeprefix("Bearer ")
        actor = "bob" if token.startswith("bob-") else "alice"
        if self.revoked:
            return self.reply({"error": {"message": "成员凭据已撤销"}}, 401)
        path = request.url.path.split("/agent/v1/")[-1]
        if path == "capabilities":
            return self.reply({"identity": {"actorId": actor, "name": actor}, "modules": [{"id": "knowledge", "state": "available"}], "operations": [{"agentAvailable": True, "description": o["name"], **o} for o in self.operations if self.allow_writes or not o.get("write")]})
        if path.startswith("operations/"):
            old = self.receipts.get((actor, path.split("/", 1)[1]))
            return self.reply({"ok": True, "result": old}) if old else self.reply({"error": {"message": "当前成员未登记此请求"}}, 404)
        body = json.loads(request.content)
        name, args = body["operation"], body["arguments"]
        if name == "identity":
            result = {"actorId": actor}
        elif name == "knowledge_read":
            doc = self.documents[args["id"]]
            result = {"item": {"id": args["id"], "projectId": doc["projectId"], "revision": doc.get("revision", 0) + 1}, "document": doc}
        elif name == "html_read":
            result = {"sha256": hashlib.sha256(self.documents[args["id"]]["content"].encode()).hexdigest()}
        elif name == "skill_read":
            result = {"version": {"sha256": hashlib.sha256(base64.b64decode(self.documents[args["id"]]["packageBase64"])).hexdigest()}}
        else:
            key = request.headers["Idempotency-Key"]
            if (actor, key) in self.receipts and self.receipts[actor, key]["state"] == "completed":
                return self.reply({"ok": True, "result": self.receipts[actor, key]["result"]})
            if name == "knowledge_save" and not args.get("sourceName", "").strip() and not args.get("sourceUrl", "").strip():
                return self.reply({"error": {"message": "请标明来源"}}, 400)
            if self.pending:
                result = {"state": "pending"}
            else:
                if name == "knowledge_save" and args.get("id"):
                    old = self.documents.get(args["id"])
                    if not old or args.get("revision") != old.get("revision", 0) + 1:
                        return self.reply({"error": {"message": "revision conflict"}}, 409)
                self.writes += 1
                identifier = args.get("id") or str(uuid.uuid4())
                self.documents[identifier] = args
                result = {"state": "published", "item": {"id": identifier, "currentVersion": args.get("revision", 0) + 1, "ownerName": actor, "fileHref": "/html/cloud/file/project/" + identifier}}
            self.receipts[actor, key] = {"state": "pending" if self.pending else "completed", "result": result}
            if self.lose_response:
                self.lose_response = False
                raise httpx.ReadTimeout("synthetic loss", request=request)
        return self.reply({"ok": True, "result": result})


@pytest.fixture
async def setup(tmp_path):
    service = FakeTools()
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    settings = Settings(token="alice-synthetic-token", expected_actor="alice", state_dir=tmp_path / "state", credential_file=tmp_path / "credentials.json", upload_roots=(uploads,))
    connector = Connector(settings, transport=httpx.MockTransport(service.handle))
    yield connector, service, uploads
    await connector.close()
