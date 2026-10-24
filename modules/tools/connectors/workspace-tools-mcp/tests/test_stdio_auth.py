import json
import os
import sys
import threading
import subprocess
import queue
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx2 as httpx
import pytest
from mcp import Client, StdioServerParameters

from tools_mcp import cli
from tools_mcp.config import API_BASE, ConnectorError, Settings
from tools_mcp.connector import Connector


@pytest.mark.parametrize("version", ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"])
def test_legacy_protocol_handshake_and_clean_stdout(tmp_path, version):
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "compatibility-test", "version": "1.0"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    ]
    env = {k: v for k, v in os.environ.items() if k not in {"TOOLS_MCP_TOKEN", "TOOLS_MCP_ACTOR_ID"}}
    process = subprocess.Popen([sys.executable, "-m", "tools_mcp", "serve", "--credential-file", str(tmp_path / "none"), "--state-dir", str(tmp_path / "state")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    replies = queue.Queue()
    def reader():
        for line in process.stdout:
            replies.put(json.loads(line))
    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    try:
        process.stdin.write(json.dumps(messages[0]) + "\n");process.stdin.flush()
        assert replies.get(timeout=10)["result"]["protocolVersion"] == version
        process.stdin.write("".join(json.dumps(m) + "\n" for m in messages[1:]));process.stdin.flush()
        listed = replies.get(timeout=10)
        assert listed["id"] == 2 and listed["result"]["tools"][0]["name"] == "tools_mcp_status"
    finally:
        process.terminate();process.wait(timeout=5)
        process.stdin.close();process.stdout.close();process.stderr.close()


async def test_real_stdio_subprocess_upload_protocol(setup, tmp_path):
    connector, service, uploads = setup
    import asyncio
    loop = asyncio.get_running_loop()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            self.dispatch()
        def do_POST(self):
            self.dispatch()
        def dispatch(self):
            request = httpx.Request(self.command, "http://127.0.0.1" + self.path, headers=dict(self.headers), content=self.rfile.read(int(self.headers.get("Content-Length", 0))))
            response = asyncio.run_coroutine_threadsafe(service.handle(request), loop).result(timeout=5)
            self.send_response(response.status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response.content)))
            self.end_headers()
            self.wfile.write(response.content)
    backend = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=backend.serve_forever, daemon=True)
    thread.start()
    file = uploads / "stdio.md"
    file.write_text("# 标准MCP进程上传")
    config = StdioServerParameters(command=sys.executable, args=["-m", "tools_mcp", "serve", "--api-base", f"http://127.0.0.1:{backend.server_port}/agent/v1", "--allow-http-localhost", "--state-dir", str(tmp_path / "stdio-state"), "--upload-root", str(uploads)], env={**os.environ, "TOOLS_MCP_TOKEN": "alice-synthetic-token", "TOOLS_MCP_ACTOR_ID": "alice"})
    try:
        async with Client(config, read_timeout_seconds=10) as client:
            listed = await client.list_tools()
            assert "knowledge_save" in {t.name for t in listed.tools}
            uploaded = await client.call_tool("tools_mcp_upload_file", {"kind": "knowledge", "path": str(file), "projectId": "project", "sourceName": "本人原创", "mcpRequestId": "stdio-process-01"})
            assert not uploaded.is_error and uploaded.structured_content["verification"] == "readback_matched"
            assert service.writes == 1
    finally:
        await asyncio.to_thread(backend.shutdown)
        backend.server_close()


async def test_missing_login_stdio_starts_without_interaction(tmp_path, monkeypatch):
    env = {k: v for k, v in os.environ.items() if k not in {"TOOLS_MCP_TOKEN", "TOOLS_MCP_ACTOR_ID"}}
    config = StdioServerParameters(command=sys.executable, args=["-m", "tools_mcp", "serve", "--credential-file", str(tmp_path / "none"), "--state-dir", str(tmp_path / "state")], env=env)
    async with Client(config, read_timeout_seconds=10) as client:
        listed = await client.list_tools()
        assert [t.name for t in listed.tools] == ["tools_mcp_status"]
        result = await client.call_tool("tools_mcp_status", {})
        assert result.is_error and result.structured_content["state"] == "authentication_required"


async def test_first_setup_shared_default_config_parent(setup, tmp_path, monkeypatch):
    _, service, _ = setup
    from tools_mcp.config import private_json
    monkeypatch.setenv("TOOLS_MCP_CONFIG_DIR", str(tmp_path / "new-config"))
    settings = Settings(token="alice-synthetic-token")
    c = Connector(settings, transport=httpx.MockTransport(service.handle))
    try:
        private_json(settings.credential_file, {"apiBase": API_BASE, "actorId": "alice", "token": "alice-synthetic-token"})
        settings.token = None
        result, error = await c.call("identity", {})
        assert not error and result["actorId"] == "alice"
    finally:
        await c.close()


async def test_terminal_login_creates_scoped_member_credential(setup, tmp_path, monkeypatch):
    _, service, _ = setup
    settings = Settings(credential_file=tmp_path / "login" / "credentials.json", state_dir=tmp_path / "login-state")
    hufu_calls = []
    async def hufu(request):
        hufu_calls.append(request)
        path = request.url.path
        if path.endswith("send-verification-otp"):
            assert json.loads(request.content) == {"email": "fixture@example.test", "type": "sign-in"}
            return httpx.Response(200, json={"success": True})
        if path.endswith("sign-in/email-otp"):
            assert json.loads(request.content)["otp"] == "123456"
            return httpx.Response(200, json={}, headers={"set-cookie": "fixture=session; Secure; Path=/"})
        if path.endswith("get-session"):
            return httpx.Response(200, json={"session": {"token": "primary-fixture"}})
        if path.endswith("/v2/me"):
            return httpx.Response(200, json={"principal_kind": "member", "is_primary": True, "actor_id": "alice"})
        if path.endswith("credentials/create"):
            body = json.loads(request.content)
            assert set(body["actions"]) == {"mem.read", "mem.upload", "mem.write", "v8.project.read"}
            assert body["until_revoked"] is True
            return httpx.Response(200, json={"credential": "alice-synthetic-token", "credential_id": "fixture-credential"})
        raise AssertionError(path)
    original = httpx.AsyncClient
    monkeypatch.setattr(cli.httpx, "AsyncClient", lambda **kwargs: original(**({"transport": httpx.MockTransport(hufu)} | kwargs)))
    monkeypatch.setattr(cli, "Connector", lambda s: Connector(s, transport=httpx.MockTransport(service.handle)))
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(cli.getpass, "getpass", lambda _: "123456")
    result = await cli.login(settings, "fixture@example.test")
    assert result["identity"]["actorId"] == "alice" and "token" not in result
    saved = json.loads(settings.credential_file.read_text())
    assert saved["createdByConnector"] and saved["actorId"] == "alice" and saved["apiBase"] == API_BASE
    assert "123456" not in settings.credential_file.read_text()
    with pytest.raises(ConnectorError):
        await cli.login(settings, "fixture@example.test")
