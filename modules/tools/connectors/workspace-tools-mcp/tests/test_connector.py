import asyncio
import json
import os
from pathlib import Path

import httpx2 as httpx
import pytest
from mcp import Client

from tools_mcp.config import API_BASE, ConnectorError, Settings, private_json, valid_base
from tools_mcp.connector import Connector
from tools_mcp.server import create_server


def document(**extra):
    return {"projectId": "project", "title": "成员实践", "body": "# 实践方法", "sourceName": "本人原创", **extra}


async def test_catalog_schema_and_sensitive_filter(setup):
    c, service, _ = setup
    tools = {d["name"]: d for d in await c.list_tools()}
    assert "knowledge_save" in tools and "tools_mcp_upload_file" in tools
    assert "mcpRequestId" in tools["knowledge_save"]["inputSchema"]["required"]
    assert "account_password_read" not in tools
    assert "private_operation" not in tools and "direct_only" not in tools
    value, error = await c.call("account_password_read", {})
    assert error and value["httpStatus"] == 403
    assert all(r.url.path.endswith("capabilities") for r in service.calls)


async def test_native_source_schema_and_caller_identity(setup):
    c, service, _ = setup
    value, error = await c.call("knowledge_save", {**document(), "mcpRequestId": "member-source-01"})
    assert not error and value["item"]["ownerName"] == "alice"
    _, error = await c.call("knowledge_save", {**document(), "owner": "forged", "mcpRequestId": "member-forged-01"})
    assert error and service.writes == 1
    value, error = await c.call("knowledge_save", {**document(sourceName=""), "mcpRequestId": "member-no-source"})
    assert error and value["httpStatus"] == 400 and service.writes == 1
    _, error = await c.call("knowledge_save", document())
    assert error and service.writes == 1


async def test_durable_idempotency_conflict_and_new_intent(setup):
    c, service, _ = setup
    args = {**document(), "mcpRequestId": "durable-write-01"}
    first, _ = await c.call("knowledge_save", args)
    other = Connector(c.settings, transport=httpx.MockTransport(service.handle))
    try:
        again, error = await other.call("knowledge_save", args)
        assert not error and again["item"]["id"] == first["item"]["id"] and service.writes == 1
        changed, error = await other.call("knowledge_save", {**args, "body": "different"})
        assert error and changed["httpStatus"] == 409 and service.writes == 1
        await other.call("knowledge_save", {**args, "mcpRequestId": "durable-new-intent"})
        assert service.writes == 2
    finally:
        await other.close()


async def test_lost_response_and_original_retry(setup):
    c, service, _ = setup
    service.lose_response = True
    args = {**document(), "mcpRequestId": "lost-response-01"}
    result, error = await c.call("knowledge_save", args)
    assert error and result["state"] == "pending" and service.writes == 1
    status, error = await c.call("tools_mcp_request_status", {"mcpRequestId": args["mcpRequestId"]})
    assert not error and status["state"] == "completed"
    recovered, error = await c.call("tools_mcp_retry", {"mcpRequestId": args["mcpRequestId"]})
    assert not error and recovered["state"] == "published" and service.writes == 1


async def test_pending_and_member_isolation(setup):
    c, service, _ = setup
    service.pending = True
    result, error = await c.call("knowledge_save", {**document(), "mcpRequestId": "pending-native-01"})
    assert not error and result["state"] == "pending"
    service.pending = False
    recovered, error = await c.call("tools_mcp_retry", {"mcpRequestId": "pending-native-01"})
    assert not error and recovered["state"] == "published"
    c.settings.token, c.settings.expected_actor = "bob-synthetic-token", "bob"
    result, error = await c.call("tools_mcp_request_status", {"mcpRequestId": "pending-native-01"})
    assert error and result["httpStatus"] == 404


@pytest.mark.parametrize("kind,filename,text", [("knowledge", "方法.md", "# 知识\n\n本人实践"), ("html", "report.html", "<!doctype html><html><body>汇报</body></html>"), ("skill", "SKILL.md", "---\nname: fixture\ndescription: fixture\n---\n# Method")])
async def test_silent_file_upload_and_readback(setup, kind, filename, text):
    c, service, uploads = setup
    file = uploads / filename
    file.write_text(text)
    args = {"kind": kind, "path": str(file), "projectId": "project", "sourceName": "本人原创", "mcpRequestId": "upload-" + kind + "-01"}
    value, error = await c.call("tools_mcp_upload_file", args)
    assert not error and value["state"] == "published" and value["verification"] == "readback_matched"
    assert value["uploadedBy"]["actorId"] == "alice" and not value["executedPackage"]
    file.write_text("changed")
    _, error = await c.call("tools_mcp_upload_file", args)
    assert error and service.writes == 1
    value, error = await c.call("tools_mcp_retry", {"mcpRequestId": args["mcpRequestId"]})
    assert not error and value["state"] == "published" and service.writes == 1


async def test_local_file_boundaries_and_source(setup, tmp_path):
    c, service, uploads = setup
    outside = tmp_path / "outside.md"
    outside.write_text("private")
    link = uploads / "link.md"
    link.symlink_to(outside)
    for path in [outside, link, uploads]:
        result, error = await c.call("tools_mcp_upload_file", {"kind": "knowledge", "path": str(path), "projectId": "project", "sourceName": "x", "mcpRequestId": "outside-upload-01"})
        assert error and service.writes == 0
    file = uploads / "no-source.md"
    file.write_text("method")
    _, error = await c.call("tools_mcp_upload_file", {"kind": "knowledge", "path": str(file), "projectId": "project", "mcpRequestId": "no-source-upload"})
    assert error and service.writes == 0
    file.write_bytes(b"x" * (1024**2 + 1))
    _, error = await c.call("tools_mcp_upload_file", {"kind": "knowledge", "path": str(file), "projectId": "project", "sourceName": "x", "mcpRequestId": "too-large-upload"})
    assert error and service.writes == 0


async def test_revocation_readonly_and_secret_redaction(setup):
    c, service, _ = setup
    await c.list_tools()
    service.allow_writes = False
    _, error = await c.call("knowledge_save", {**document(), "mcpRequestId": "revoked-write-01"})
    assert error and service.writes == 0
    c.settings.read_only = True
    names = {t["name"] for t in await c.list_tools()}
    assert "tools_mcp_retry" not in names and "tools_mcp_upload_file" not in names and "knowledge_save" not in names
    service.revoked = True
    value, error = await c.call("identity", {})
    assert error and value["state"] == "authentication_required"
    service.revoked = False
    assert c.clean({"message": "echo " + c.settings.token})["message"] == "echo [REDACTED]"


async def test_credential_file_identity_binding_and_snapshot(setup, tmp_path):
    c, service, _ = setup
    c.settings.token = None
    private_json(c.settings.credential_file, {"apiBase": API_BASE, "actorId": "bob", "token": "alice-synthetic-token"})
    result, error = await c.call("identity", {})
    assert error and "不一致" in result["message"]
    private_json(c.settings.credential_file, {"apiBase": API_BASE, "actorId": "alice", "token": "alice-synthetic-token"})
    original = service.handle
    async def rotate(request):
        result = await original(request)
        if request.url.path.endswith("capabilities"):
            private_json(c.settings.credential_file, {"apiBase": API_BASE, "actorId": "bob", "token": "bob-synthetic-token"})
        return result
    await c.http.aclose()
    c.http = httpx.AsyncClient(transport=httpx.MockTransport(rotate))
    result, error = await c.call("knowledge_save", {**document(), "mcpRequestId": "identity-snapshot"})
    assert not error and result["item"]["ownerName"] == "alice"
    assert "synthetic-token" not in (c.settings.state_dir / "requests.sqlite3").read_bytes().decode("utf-8", errors="ignore")
    if os.name != "nt":
        c.settings.credential_file.chmod(0o644)
        _, error = await c.call("identity", {})
        assert error


async def test_concurrent_same_request_only_one_mutation(setup):
    c, service, _ = setup
    args = {**document(), "mcpRequestId": "concurrent-request"}
    results = await asyncio.gather(*(c.call("knowledge_save", args) for _ in range(8)))
    assert all(not error for _, error in results) and service.writes == 1


async def test_official_sdk_tools_and_structured_output(setup):
    c, _, _ = setup
    async with Client(create_server(c)) as client:
        listed = await client.list_tools()
        write = next(t for t in listed.tools if t.name == "knowledge_save")
        assert write.annotations.read_only_hint is False
        result = await client.call_tool("knowledge_save", {**document(), "mcpRequestId": "sdk-write-method"})
        assert not result.is_error and result.structured_content["state"] == "published"
        bad = await client.call_tool("knowledge_save", {**document(), "mcpRequestId": "sdk-write-method", "body": "different"})
        assert bad.is_error and bad.structured_content["httpStatus"] == 409


def test_endpoint_binding_and_client_config(tmp_path):
    for invalid in ["http://example.com/agent/v1", "https://user:pass@example.com/agent/v1", "https://example.com/agent/v1?token=secret"]:
        with pytest.raises(ConnectorError):
            valid_base(invalid)
    from tools_mcp.cli import client_config
    cfg = client_config(Settings(credential_file=tmp_path / "credentials.json", state_dir=tmp_path / "state", upload_roots=(tmp_path / "uploads",)))
    encoded = json.dumps(cfg)
    assert "credentials.json" in encoded and "--upload-root" in encoded and "Bearer" not in encoded and "TOKEN" not in encoded


async def test_journal_isolated_by_api_endpoint(setup):
    c, service, _ = setup
    args = {**document(), "mcpRequestId": "same-request-new-endpoint"}
    await c.call("knowledge_save", args)
    other_service = type(service)()
    other_settings = Settings(api_base="https://another-tools.example/agent/v1", token=c.settings.token, expected_actor="alice", state_dir=c.settings.state_dir)
    other = Connector(other_settings, transport=httpx.MockTransport(other_service.handle))
    try:
        result, error = await other.call("knowledge_save", args)
        assert not error and other_service.writes == 1
    finally:
        await other.close()


async def test_json_source_type_rejected_and_html_bom_preserved(setup):
    c, service, uploads = setup
    file = uploads / "knowledge.json"
    file.write_text(json.dumps({"body": "method", "sourceName": 7}))
    result, error = await c.call("tools_mcp_upload_file", {"kind": "knowledge", "path": str(file), "projectId": "project", "mcpRequestId": "bad-json-source-01"})
    assert error and service.writes == 0
    html = uploads / "bom.html"
    html.write_text("\ufeff<!doctype html><html>中文</html>")
    result, error = await c.call("tools_mcp_upload_file", {"kind": "html", "path": str(html), "projectId": "project", "mcpRequestId": "html-bom-source-01"})
    assert not error and result["verification"] == "readback_matched"
