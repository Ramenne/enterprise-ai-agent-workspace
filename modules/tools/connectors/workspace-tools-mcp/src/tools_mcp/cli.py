from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
import uuid
from pathlib import Path

import httpx2 as httpx

from . import __version__
from .config import API_BASE, HUFU_BASE, ConnectorError, Settings, config_home, private_json
from .connector import Connector


def settings_from(args) -> Settings:
    return Settings(api_base=args.api_base, credential_file=Path(args.credential_file), state_dir=Path(args.state_dir), upload_roots=tuple(Path(p) for p in args.upload_root), read_only=args.read_only, allow_local=args.allow_http_localhost)


async def hufu_request(client, path, body=None, token=None, key=None):
    try:
        response = await client.request("POST" if body is not None else "GET", HUFU_BASE + path, headers={"Accept": "application/json", "Origin": "https://hufu.example.invalid/", **({"Authorization": "Bearer " + token} if token else {}), **({"Idempotency-Key": key} if key else {})}, **({"json": body} if body is not None else {}))
        data = response.json()
    except (httpx.HTTPError, ValueError):
        raise ConnectorError("身份权限服务连接未确认，请稍后重试登录；凭据不会输出到终端") from None
    if response.status_code >= 300:
        raise ConnectorError(f"身份权限服务未完成此操作（HTTP {response.status_code}）；请核对现有成员邮箱、验证码和权限")
    return data


async def verify_and_save(settings: Settings, token: str, *, created=False, credential_id=None) -> dict:
    if settings.credential_file.exists():
        raise ConnectorError("凭据文件已存在；请先logout，或指定另一个 --credential-file，避免覆盖已有成员")
    settings.token = token
    connector = Connector(settings)
    try:
        catalog = await connector.discover()
        identity = catalog["identity"]
        private_json(settings.credential_file, {"version": 1, "apiBase": settings.api_base, "actorId": identity["actorId"], "memberName": identity.get("name", "成员"), "credentialId": credential_id, "createdByConnector": created, "token": token})
        return {"state": "authenticated", "identity": identity, "credentialFile": str(settings.credential_file), "nativeTools": len(connector.definitions)}
    finally:
        await connector.close()


async def login(settings: Settings, email: str | None) -> dict:
    if settings.credential_file.exists():
        raise ConnectorError("凭据文件已存在，请先logout或选择其他凭据文件")
    if not sys.stdin.isatty():
        raise ConnectorError("login须在本人终端交互运行；MCP进程不会要求输入验证码")
    email = email or input("中枢成员邮箱：").strip()
    if not email or "@" not in email:
        raise ConnectorError("请提供已绑定的中枢成员邮箱")
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        await hufu_request(client, "/v2/auth/email-otp/send-verification-otp", {"email": email, "type": "sign-in"})
        otp = getpass.getpass("邮箱验证码（输入不显示）：").strip()
        await hufu_request(client, "/v2/auth/sign-in/email-otp", {"email": email, "otp": otp})
        session = await hufu_request(client, "/v2/auth/get-session")
        primary = session.get("session", {}).get("token")
        if not primary:
            raise ConnectorError("身份权限服务未返回当前成员会话")
        me = await hufu_request(client, "/v2/me", token=primary)
        if me.get("principal_kind") != "member" or me.get("is_primary") is not True:
            raise ConnectorError("须使用本人当前中枢成员身份登录")
        grant = await hufu_request(client, "/v2/credentials/create", {"label": "TOOLS MCP 独立连接器", "actions": ["mem.read", "mem.upload", "mem.write", "v8.project.read"], "until_revoked": True, "expires_at": None}, token=primary, key="tools-mcp-login-" + str(uuid.uuid4()))
        token = grant.get("credential")
        if not token or not grant.get("credential_id"):
            raise ConnectorError("身份权限服务尚未确认连接器凭据创建")
        settings.expected_actor = me["actor_id"]
        try:
            return await verify_and_save(settings, token, created=True, credential_id=grant["credential_id"])
        except Exception:
            # A failed local setup must not leave a newly issued credential active.
            try:
                await hufu_request(client, "/v2/credentials/revoke", {"credential_id": grant["credential_id"]}, token=token, key="tools-mcp-setup-rollback-" + grant["credential_id"])
            except ConnectorError:
                print("本地配置未完成；请在身份权限服务凭据管理核对TOOLS MCP凭据并按需撤销。", file=sys.stderr)
            raise


async def logout(settings: Settings, local_only: bool) -> dict:
    if not settings.credential_file.exists():
        return {"state": "already_logged_out"}
    credentials = settings.credentials()
    revoked = False
    if credentials.get("createdByConnector") and credentials.get("credentialId") and not local_only:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            await hufu_request(client, "/v2/credentials/revoke", {"credential_id": credentials["credentialId"]}, token=credentials["token"], key="tools-mcp-logout-" + credentials["credentialId"])
        revoked = True
    settings.credential_file.unlink()
    return {"state": "logged_out", "connectorCredentialRevoked": revoked, "importedCredential": not credentials.get("createdByConnector", False)}


def client_config(settings: Settings) -> dict:
    args = ["-m", "tools_mcp", "serve", "--api-base", settings.api_base, "--credential-file", str(settings.credential_file), "--state-dir", str(settings.state_dir)]
    for root in settings.upload_roots:
        args += ["--upload-root", str(root)]
    if settings.read_only:
        args += ["--read-only"]
    if settings.allow_local:
        args += ["--allow-http-localhost"]
    return {"mcpServers": {"workspace-tools": {"command": sys.executable, "args": args}}}


def parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--api-base", default=os.environ.get("TOOLS_MCP_API_BASE", API_BASE))
    common.add_argument("--credential-file", default=os.environ.get("TOOLS_MCP_CREDENTIAL_FILE", str(config_home() / "credentials.json")))
    common.add_argument("--state-dir", default=os.environ.get("TOOLS_MCP_STATE_DIR", str(config_home() / "state")))
    common.add_argument("--upload-root", action="append", default=[p for p in os.environ.get("TOOLS_MCP_UPLOAD_ROOTS", "").split(os.pathsep) if p])
    common.add_argument("--read-only", action="store_true", default=os.environ.get("TOOLS_MCP_READ_ONLY") == "1")
    common.add_argument("--allow-http-localhost", action="store_true", help=argparse.SUPPRESS)
    root = argparse.ArgumentParser(description="协作平台TOOLS独立MCP：stdio直连HTTP API，不操作浏览器")
    root.add_argument("--version", action="version", version=__version__)
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("serve", parents=[common], help="启动stdio MCP服务")
    commands.add_parser("doctor", parents=[common], help="只读检查成员身份和工具目录")
    login_parser = commands.add_parser("login", parents=[common], help="本人邮箱验证码登录，创建可撤销的成员连接器凭据")
    login_parser.add_argument("--email")
    commands.add_parser("import-token", parents=[common], help="隐藏输入已有本人身份权限服务Bearer凭据并核验，不输出凭据")
    logout_parser = commands.add_parser("logout", parents=[common], help="退出并撤销由本连接器创建的凭据")
    logout_parser.add_argument("--local-only", action="store_true")
    config_parser = commands.add_parser("config", parents=[common], help="生成不含凭据的标准MCP客户端JSON配置")
    config_parser.add_argument("--output", type=Path)
    return root


async def run(args) -> int:
    settings = settings_from(args)
    if args.command == "serve":
        from .server import serve
        await serve(Connector(settings))
        return 0
    if args.command == "config":
        content = json.dumps(client_config(settings), ensure_ascii=False, indent=2) + "\n"
        if args.output:
            args.output.write_text(content, encoding="utf-8")
            print("已生成不含凭据的配置：" + str(args.output.absolute()))
        else:
            print(content, end="")
        return 0
    if args.command == "login":
        result = await login(settings, args.email)
    elif args.command == "import-token":
        if not sys.stdin.isatty():
            raise ConnectorError("请在本人终端隐藏输入凭据；自动化可用TOOLS_MCP_TOKEN环境变量，不把凭据放进命令参数")
        result = await verify_and_save(settings, getpass.getpass("本人身份权限服务Bearer凭据（不含Bearer前缀，输入不显示）：").strip())
    elif args.command == "logout":
        result = await logout(settings, args.local_only)
    else:
        connector = Connector(settings)
        try:
            result, error = await connector.call("tools_mcp_status", {})
        finally:
            await connector.close()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return int(error)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def main() -> None:
    try:
        args = parser().parse_args(sys.argv[1:] or ["serve"])
        raise SystemExit(asyncio.run(run(args)))
    except ConnectorError as error:
        print("TOOLS MCP：" + str(error), file=sys.stderr)
        raise SystemExit(1)
    except KeyboardInterrupt:
        raise SystemExit(130)
