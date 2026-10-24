import json

import httpx2 as httpx
import pytest


async def test_metadata_survives_upload_and_same_item_revision(setup):
    c, service, uploads = setup
    path = uploads / "practice.json"
    doc = {
        "title": "员工客户端消息更新", "body": "正常在线收到事件后补取变化。",
        "sourceName": "项目实践整理", "tags": "员工客户端,聊天,事件触发",
        "scope": "正常在线的聊天窗口", "limitations": "断线恢复另按游标补缺",
        "evidence": "场景验收记录", "status": "partial", "summary": "事件与恢复分开",
        "category": "项目实践", "sourceUrl": "https://example.test/source",
        "skillId": "method-id", "skillTitle": "提炼方法", "reportHref": "https://example.test/report",
        "reportTitle": "验收记录",
    }
    path.write_text(json.dumps({"document": doc}, ensure_ascii=False))
    args = {"kind": "knowledge", "path": str(path), "projectId": "project", "mcpRequestId": "metadata-create-01"}
    first, error = await c.call("tools_mcp_upload_file", args)
    assert not error and first["verification"] == "readback_matched"
    identifier = first["item"]["id"]
    assert all(service.documents[identifier][key] == value for key, value in doc.items())

    updated, error = await c.call("tools_mcp_upload_file", {
        **args, "id": identifier, "revision": 1, "tags": "", "summary": "",
        "mcpRequestId": "metadata-revise-01",
    })
    assert not error and updated["item"]["id"] == identifier and updated["item"]["currentVersion"] == 2
    assert service.documents[identifier]["tags"] == "" and service.documents[identifier]["summary"] == ""
    assert len(service.documents) == 1 and service.writes == 2
    replay, error = await c.call("tools_mcp_upload_file", {
        **args, "id": identifier, "revision": 1, "tags": "", "summary": "",
        "mcpRequestId": "metadata-revise-01",
    })
    assert not error and replay["verification"] == "readback_matched" and service.writes == 2
    conflict, error = await c.call("tools_mcp_upload_file", {
        **args, "id": identifier, "revision": 1, "mcpRequestId": "metadata-stale-01",
    })
    assert error and conflict["httpStatus"] == 409 and len(service.documents) == 1


@pytest.mark.parametrize("partial", [{"id": "existing"}, {"revision": 1}])
async def test_revision_requires_explicit_pair_before_any_write(setup, partial):
    c, service, uploads = setup
    path = uploads / "method.md"
    path.write_text("方法")
    value, error = await c.call("tools_mcp_upload_file", {
        "kind": "knowledge", "path": str(path), "projectId": "project", "sourceName": "本人实践",
        "mcpRequestId": "incomplete-update", **partial,
    })
    assert error and value["httpStatus"] == 400 and service.writes == 0


async def test_update_cannot_clear_existing_context_by_omission(setup):
    c, service, uploads = setup
    path = uploads / "body-only.md"
    path.write_text("修改正文")
    value, error = await c.call("tools_mcp_upload_file", {
        "kind": "knowledge", "path": str(path), "projectId": "project", "id": "existing",
        "revision": 1, "sourceName": "本人实践", "mcpRequestId": "body-only-update",
    })
    assert error and value["httpStatus"] == 400 and service.writes == 0


@pytest.mark.parametrize("field,value", [("tags", ["员工客户端"]), ("newSemanticField", "不能丢失")])
async def test_invalid_or_unsupported_json_metadata_is_not_silently_dropped(setup, field, value):
    c, service, uploads = setup
    path = uploads / "method.json"
    path.write_text(json.dumps({"body": "方法", "sourceName": "本人实践", field: value}))
    result, error = await c.call("tools_mcp_upload_file", {
        "kind": "knowledge", "path": str(path), "projectId": "project", "mcpRequestId": "invalid-metadata",
    })
    assert error and result["httpStatus"] == 400 and service.writes == 0


async def test_dropped_metadata_readback_is_not_reported_as_verified(setup):
    c, service, uploads = setup
    original = service.handle
    async def drop_scope(request):
        response = await original(request)
        if request.url.path.endswith("/call") and json.loads(request.content)["operation"] == "knowledge_read":
            packet = json.loads(response.content)
            packet["result"]["document"].pop("scope", None)
            return service.reply(packet)
        return response
    await c.http.aclose()
    c.http = httpx.AsyncClient(transport=httpx.MockTransport(drop_scope))
    path = uploads / "method.json"
    path.write_text(json.dumps({"body": "方法", "sourceName": "本人实践", "scope": "仅正常在线"}))
    value, error = await c.call("tools_mcp_upload_file", {
        "kind": "knowledge", "path": str(path), "projectId": "project", "mcpRequestId": "metadata-readback-loss",
    })
    assert error and value["state"] == "saved_verification_pending" and service.writes == 1
