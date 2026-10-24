from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import os
import re
import sqlite3
import stat
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx2 as httpx
from jsonschema import Draft202012Validator

from .config import ConnectorError, Settings, private_directory

REQUEST_ID = {"type": "string", "minLength": 8, "maxLength": 120, "pattern": "^[a-zA-Z0-9_.:-]+$", "description": "本次业务请求的固定标识。同一上传重试必须保持此标识和原参数；新的独立操作使用新标识。"}
HARD_BLOCKED = {"account_password_read", "account_notes_read", "account_history", "account_save", "account_members", "account_group_delete", "account_access_read", "account_access_save", "account_member_access_read", "account_member_access_save", "account_member_visibility_save", "skill_package_read", "hardware_file_read"}
PREFIX = "_toolsMcp"
KNOWLEDGE_TEXT_FIELDS = (
    "title", "body", "category", "summary", "tags", "status", "sourceName",
    "sourceUrl", "scope", "limitations", "evidence", "reportHref", "reportTitle",
    "skillId", "skillTitle",
)
KNOWLEDGE_EDIT_FIELDS = {
    **{field: {"type": "string"} for field in KNOWLEDGE_TEXT_FIELDS if field != "body"},
    "id": {"type": "string", "minLength": 1, "description": "修订既有知识的稳定 ID；必须同时提供 revision"},
    "revision": {"type": "integer", "minimum": 1, "description": "当前目录 revision；冲突时重新读取，不新增副本"},
}


def knowledge_payload(document: dict, arguments: dict, title: str) -> dict:
    """Preserve editable fields; explicit empty values are meaningful updates."""
    payload = {field: document[field] for field in KNOWLEDGE_TEXT_FIELDS if field in document}
    payload.update({field: arguments[field] for field in KNOWLEDGE_EDIT_FIELDS if field in arguments})
    for field in ("id", "revision"):
        if field not in payload and field in document:
            payload[field] = document[field]
    if ("id" in payload) != ("revision" in payload):
        raise ConnectorError("修订知识须同时提供 id 和当前 revision；不以新增代替修订", status=400)
    if "id" in payload and set(KNOWLEDGE_TEXT_FIELDS) - set(payload):
        raise ConnectorError("修订须先读取原条目并提交完整知识字段（未使用字段也显式为空），防止省略的元信息被默认值清空", status=400)
    # A document from a future knowledge model must not silently lose new fields.
    supported = set(KNOWLEDGE_TEXT_FIELDS) | {"id", "revision", "projectId", "projectName"}
    if set(document) - supported:
        raise ConnectorError("知识JSON包含当前上传工具不支持的字段；请按当前 knowledge_save 契约整理，不能静默丢弃", status=400)
    payload["projectId"] = arguments["projectId"]
    payload["projectName"] = arguments.get("projectName", document.get("projectName", "资料存储服务项目"))
    payload.setdefault("title", title)
    payload.setdefault("category", "未分类")
    payload.setdefault("summary", "")
    for field in KNOWLEDGE_TEXT_FIELDS:
        if field in payload:
            if not isinstance(payload[field], str):
                raise ConnectorError("知识正文和元信息须按当前API提供文本", status=400)
            payload[field] = re.sub(r"^[\s\ufeff]+|[\s\ufeff]+$", "", payload[field])
    if not payload.get("sourceName", "") and not payload.get("sourceUrl", ""):
        raise ConnectorError("知识文档须标明来源说明或来源链接；原创可注明本人原创", status=400)
    return payload


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def schema(properties: dict | None = None, required: list | None = None) -> dict:
    return {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}


class Journal:
    """Private member-scoped retry records. No authentication material is stored."""

    def __init__(self, path: Path, scope: str):
        self.scope = scope
        private_directory(path.parent)
        if path.is_symlink():
            raise ConnectorError("请求记录不能是符号链接")
        fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(fd)
        if os.name != "nt":
            os.chmod(path, 0o600)
        self.db = sqlite3.connect(path, timeout=20)
        self.db.row_factory = sqlite3.Row
        self.db.execute("CREATE TABLE IF NOT EXISTS requests(actor TEXT NOT NULL, request_id TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL, arguments TEXT NOT NULL, api_key TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated REAL NOT NULL, PRIMARY KEY(actor,request_id))")
        self.db.commit()

    def get(self, actor: str, request_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM requests WHERE actor=? AND request_id=?", (self.scope + "\0" + actor, request_id)).fetchone()
        return dict(row) if row else None

    def prepare(self, actor: str, request_id: str, operation: str, arguments: dict, api_key: str) -> dict:
        raw = canonical(arguments)
        fingerprint = hashlib.sha256(canonical([operation, arguments]).encode()).hexdigest()
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO requests VALUES(?,?,?,?,?,?,'pending',NULL,?)", (self.scope + "\0" + actor, request_id, operation, fingerprint, raw, api_key, time.time()))
            row = self.get(actor, request_id)
            if row["fingerprint"] != fingerprint:
                raise ConnectorError("该mcpRequestId已用于其他参数；重试请使用原参数，独立新操作使用新标识", status=409)
        return row

    def finish(self, actor: str, request_id: str, state: str, result: dict) -> None:
        with self.db:
            self.db.execute("UPDATE requests SET state=?,result=?,updated=? WHERE actor=? AND request_id=?", (state, canonical(result), time.time(), self.scope + "\0" + actor, request_id))

    def close(self) -> None:
        self.db.close()


class Connector:
    def __init__(self, settings: Settings, *, transport=None):
        self.settings = settings
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(300, connect=20), follow_redirects=False, transport=transport)
        self.journal = Journal(settings.state_dir / "requests.sqlite3", settings.api_base)
        self.locks: dict[tuple[str, str], asyncio.Lock] = {}
        self.catalog: dict = {}
        self.definitions: dict[str, dict] = {}
        self._secrets: set[str] = set()
        self._credential: ContextVar[dict | None] = ContextVar("tools_mcp_credential", default=None)
        self._discovery: ContextVar[tuple[dict, dict] | None] = ContextVar("tools_mcp_discovery", default=None)

    async def close(self) -> None:
        await self.http.aclose()
        self.journal.close()

    def clean(self, value: Any) -> Any:
        if isinstance(value, str):
            for token in self._secrets:
                value = value.replace(token, "[REDACTED]")
            return value
        if isinstance(value, dict):
            return {k: self.clean(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.clean(v) for v in value]
        return value

    async def request(self, path: str, body: dict | None = None, key: str | None = None) -> dict:
        credential = self._credential.get() or self.settings.credentials()
        self._secrets.add(credential["token"])
        headers = {"Authorization": "Bearer " + credential["token"], "Accept": "application/json"}
        if key:
            headers["Idempotency-Key"] = key
        try:
            response = await self.http.request("POST" if body is not None else "GET", self.settings.api_base + "/" + path, headers=headers, **({"json": body} if body is not None else {}))
        except httpx.HTTPError:
            raise ConnectorError("TOOLS连接未确认；写入请保留mcpRequestId，核对或重试原请求", state="pending" if body is not None else "unavailable") from None
        try:
            data = response.json()
        except ValueError:
            raise ConnectorError("TOOLS响应格式未确认，请保留原请求标识核对", state="pending" if body is not None else "unavailable") from None
        if response.status_code >= 300 or data.get("ok") is False:
            error = data.get("error", {})
            message = error.get("message") if isinstance(error, dict) else str(error)
            state = "authentication_required" if response.status_code == 401 else "pending" if response.status_code >= 500 else "failed"
            raise ConnectorError(self.clean(message or f"TOOLS接口未完成（HTTP {response.status_code}）"), state=state, status=response.status_code)
        return data.get("result", data)

    async def discover(self) -> dict:
        credential = self._credential.get() or self.settings.credentials()
        catalog = await self.request("capabilities")
        actor = catalog.get("identity", {}).get("actorId")
        if not isinstance(actor, str) or not actor or (credential.get("actorId") and actor != credential["actorId"]):
            raise ConnectorError("TOOLS返回成员与配置身份不一致，拒绝调用")
        definitions = {}
        for operation in catalog.get("operations", []):
            name = operation.get("name", "")
            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", name) or name.startswith("tools_mcp_") or name in HARD_BLOCKED:
                continue
            if not operation.get("agentAvailable", False) or operation.get("sensitive") or (self.settings.read_only and operation.get("write")):
                continue
            if not isinstance(operation.get("inputSchema"), dict):
                continue
            Draft202012Validator.check_schema(operation["inputSchema"])
            definitions[name] = operation
        self.catalog, self.definitions = catalog, definitions
        self._discovery.set((catalog, definitions))
        return catalog

    def helper_definitions(self) -> list[dict]:
        helpers = [
            {"name": "tools_mcp_status", "description": "核对独立TOOLS MCP的登录状态、真实成员、模块、只读模式和文件上传目录；不返回凭据。", "inputSchema": schema(), "write": False},
            {"name": "tools_mcp_request_status", "description": "按本连接器原mcpRequestId核对当前成员的写入回执；返回pending时不能宣称上传完成。", "inputSchema": schema({"mcpRequestId": REQUEST_ID}, ["mcpRequestId"]), "write": False},
        ]
        if not self.settings.read_only:
            helpers.append({"name": "tools_mcp_retry", "description": "用本机记录的原参数和原标识恢复当前成员的一项写入；不改写正文，不重新读取可能变化的文件。", "inputSchema": schema({"mcpRequestId": REQUEST_ID}, ["mcpRequestId"]), "write": True})
        if self.settings.upload_roots and not self.settings.read_only:
            helpers.append({"name": "tools_mcp_upload_file", "description": "直接通过HTTP API静默上传配置目录内的明确文件。knowledge支持UTF-8的md/txt/json，须来源说明或链接；html支持html/htm；skill支持SKILL.md/zip且不执行。成功后读回核对；项目资格由当前成员决定。不会操作浏览器。", "write": True, "inputSchema": schema({
                "kind": {"type": "string", "enum": ["knowledge", "html", "skill"]},
                "path": {"type": "string", "description": "位于已配置上传目录内的文件绝对路径"},
                "projectId": {"type": "string", "description": "知识和HTML必填，使用projects_list返回的真实项目ID"},
                "projectName": {"type": "string"}, "title": {"type": "string"},
                "sourceName": {"type": "string", "description": "知识来源说明；原创可注明本人原创"},
                "sourceUrl": {"type": "string"}, "category": {"type": "string"}, "summary": {"type": "string"},
                **KNOWLEDGE_EDIT_FIELDS,
                "mcpRequestId": REQUEST_ID,
            }, ["kind", "path", "mcpRequestId"])})
        return helpers

    async def list_tools(self) -> list[dict]:
        helpers = self.helper_definitions()
        try:
            context = self._credential.set(self.settings.credentials())
        except ConnectorError:
            return [h for h in helpers if h["name"] == "tools_mcp_status"]
        try:
            await self.discover()
        except ConnectorError:
            return [h for h in helpers if h["name"] == "tools_mcp_status"]
        finally:
            self._credential.reset(context)
        result = []
        for operation in self._discovery.get()[1].values():
            item = copy.deepcopy(operation)
            if item.get("write"):
                item["inputSchema"].setdefault("properties", {})["mcpRequestId"] = REQUEST_ID
                item["inputSchema"]["required"] = list(dict.fromkeys(item["inputSchema"].get("required", []) + ["mcpRequestId"]))
            result.append(item)
        return result + helpers

    @staticmethod
    def validate(arguments: dict, rule: dict) -> None:
        errors = sorted(Draft202012Validator(rule).iter_errors(arguments), key=lambda e: str(list(e.path)))
        if errors:
            # Do not echo invalid values (document text or credentials) into an error.
            error = errors[0]
            location = ".".join(str(x) for x in error.path) or "arguments"
            required = ",".join(rule.get("required", []))
            raise ConnectorError(f"工具参数校验未通过：{location}（{error.validator}）；必填字段：{required}", status=400)

    async def native(self, name: str, arguments: dict, request_id: str | None = None, *, discovered: bool = False) -> dict:
        if not discovered or self._discovery.get() is None:
            await self.discover()
        catalog, definitions = self._discovery.get()
        definition = definitions.get(name)
        if not definition:
            raise ConnectorError("当前成员或本连接器不允许调用该工具", status=403)
        self.validate(arguments, definition["inputSchema"])
        if any(token in canonical(arguments) for token in self._secrets):
            raise ConnectorError("上传内容包含当前连接凭据，已拒绝保存")
        if not definition.get("write"):
            return await self.request("call", {"operation": name, "arguments": arguments})
        self.validate({"mcpRequestId": request_id}, schema({"mcpRequestId": REQUEST_ID}, ["mcpRequestId"]))
        actor = catalog["identity"]["actorId"]
        key = "tools-mcp:" + hashlib.sha256((actor + "\0" + request_id).encode()).hexdigest()
        async with self.locks.setdefault((actor, request_id), asyncio.Lock()):
            old = self.journal.prepare(actor, request_id, name, arguments, key)
            if old["state"] == "completed":
                return {**json.loads(old["result"]), PREFIX: {"mcpRequestId": request_id, "idempotencyKey": key, "replayed": True}}
            try:
                previous = await self.request("operations/" + quote(key, safe=""))
            except ConnectorError as error:
                if error.status != 404:
                    raise
                previous = None
            if previous and previous.get("state") == "completed":
                result = previous["result"]
            else:
                result = await self.request("call", {"operation": name, "arguments": arguments}, key)
            pending = result.get("state") in {"pending", "preparing"}
            self.journal.finish(actor, request_id, "pending" if pending else "completed", result)
            return {**result, PREFIX: {"mcpRequestId": request_id, "idempotencyKey": key, "transport": "http-api"}}

    async def request_status(self, request_id: str, *, retry: bool = False) -> dict:
        await self.discover()
        actor = self._discovery.get()[0]["identity"]["actorId"]
        row = self.journal.get(actor, request_id)
        if not row:
            raise ConnectorError("当前成员在本连接器没有此请求记录", status=404)
        if retry:
            return await self.native(row["operation"], json.loads(row["arguments"]), request_id, discovered=True)
        try:
            result = await self.request("operations/" + quote(row["api_key"], safe=""))
        except ConnectorError as error:
            if error.status == 404:
                return {"state": "not_registered", "mcpRequestId": request_id, "next": "tools_mcp_retry"}
            raise
        return {**result, "mcpRequestId": request_id}

    def read_upload(self, supplied: str, limit: int) -> tuple[Path, bytes]:
        path = Path(supplied).expanduser()
        if not path.is_absolute():
            raise ConnectorError("上传须提供文件绝对路径")
        try:
            resolved = path.resolve(strict=True)
            if not any(resolved.is_relative_to(root) for root in self.settings.upload_roots):
                raise ConnectorError("文件不在已配置上传目录内；请将该文件放入上传目录，或由本人配置新的目录")
            # Refuse symlinks, devices and special files. O_NOFOLLOW closes the final-component race.
            if path.is_symlink():
                raise ConnectorError("上传不接受符号链接")
            fd = os.open(resolved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                    raise ConnectorError("上传须为普通文件，且不能超过该管理库限额")
                data = stream.read(limit + 1)
            if not data or len(data) > limit:
                raise ConnectorError("上传文件为空或超过管理库限额")
            return resolved, data
        except OSError:
            raise ConnectorError("上传文件不存在或当前进程无法读取") from None

    async def upload(self, arguments: dict) -> dict:
        kind = arguments["kind"]
        if kind != "knowledge" and any(field in arguments for field in KNOWLEDGE_EDIT_FIELDS if field not in {"title", "category", "summary", "sourceName", "sourceUrl"}):
            raise ConnectorError("知识修订与元信息参数仅适用于 kind=knowledge", status=400)
        path, data = self.read_upload(arguments["path"], {"knowledge": 1024**2, "html": 2 * 1024**2, "skill": 5 * 1024**2}[kind])
        title = arguments.get("title") or path.stem
        project = arguments.get("projectId")
        if kind != "skill" and not project:
            raise ConnectorError("知识和HTML上传须填写projects_list返回的projectId")
        content = None
        if kind != "skill":
            try:
                content = data.decode("utf-8")
            except UnicodeDecodeError:
                raise ConnectorError("知识和HTML须为UTF-8文本；PDF/Word请先由文档工具提取正文") from None
        if kind == "knowledge":
            if path.suffix.lower() not in {".md", ".txt", ".json"}:
                raise ConnectorError("知识上传支持md、txt、json")
            document = {}
            if path.suffix.lower() == ".json":
                try:
                    parsed = json.loads(content.lstrip("\ufeff"))
                    document = parsed.get("document", parsed)
                    if not isinstance(document, dict) or not isinstance(document.get("body"), str):
                        raise ValueError()
                except (ValueError, AttributeError):
                    raise ConnectorError("知识JSON须包含document.body或body正文") from None
            payload = knowledge_payload({**document, "body": document.get("body", content)}, arguments, title)
            operation = "knowledge_save"
        elif kind == "html":
            if path.suffix.lower() not in {".html", ".htm"}:
                raise ConnectorError("HTML上传须为html或htm文件")
            payload = {"projectId": project, "projectTitle": arguments.get("projectName", "资料存储服务项目"), "filename": path.name, "path": "汇报/" + path.name, "title": title, "content": content, "kind": "资料"}
            operation = "html_save"
        else:
            if path.name != "SKILL.md" and path.suffix.lower() != ".zip":
                raise ConnectorError("Skill上传须为SKILL.md或zip包；不会执行包内代码")
            payload = {"filename": path.name, "packageBase64": base64.b64encode(data).decode(), "title": title}
            operation = "skill_import"
        result = await self.native(operation, payload, arguments["mcpRequestId"])
        if result.get("state") != "published":
            return result
        item = result.get("item", {})
        try:
            if kind == "knowledge":
                read = await self.native("knowledge_read", {"id": item["id"], "version": item["currentVersion"]})
                mismatched = [field for field in KNOWLEDGE_TEXT_FIELDS
                              if field in payload and read["document"].get(field) != payload[field]]
                # Placement and update identity are as important as body integrity.
                read_item = read.get("item", {})
                if read_item.get("projectId") != payload["projectId"]:
                    mismatched.append("projectId")
                if "id" in payload and (item["id"] != payload["id"] or read_item.get("id") != payload["id"]):
                    mismatched.append("id")
                if "revision" in payload and read_item.get("revision") != payload["revision"] + 1:
                    mismatched.append("revision")
                matched = not mismatched
                url = self.settings.api_base.split("/agent/v1")[0] + "/knowledge/?id=" + item["id"]
            elif kind == "html":
                read = await self.native("html_read", {"projectId": project, "id": item["id"]})
                matched = read.get("sha256") == hashlib.sha256(content.encode()).hexdigest()
                url = self.settings.api_base.split("/agent/v1")[0] + item["fileHref"]
            else:
                read = await self.native("skill_read", {"id": item["id"], "version": item["currentVersion"]})
                matched = read["version"]["sha256"] == hashlib.sha256(data).hexdigest()
                url = self.settings.api_base.split("/agent/v1")[0] + "/skills/?id=" + item["id"]
            if not matched:
                raise ConnectorError("已保存但本次读回核对未通过，请保留原请求标识", state="saved_verification_pending")
        except (ConnectorError, KeyError) as error:
            return {**result, "state": "saved_verification_pending", "verification": "unconfirmed", "message": str(error) if isinstance(error, ConnectorError) else "已保存，返回引用尚未完成核对"}
        return {**result, "url": url, "verification": "readback_matched", "fileSha256": hashlib.sha256(data).hexdigest(), "uploadedBy": self._discovery.get()[0]["identity"], "executedPackage": False}

    async def call(self, name: str, arguments: dict) -> tuple[dict, bool]:
        context = None
        try:
            context = self._credential.set(self.settings.credentials())
            return await self._call(name, arguments)
        except ConnectorError as error:
            return {"state": error.state, "message": self.clean(str(error))}, True
        finally:
            if context is not None:
                self._credential.reset(context)

    async def _call(self, name: str, arguments: dict) -> tuple[dict, bool]:
        try:
            helpers = {h["name"]: h for h in self.helper_definitions()}
            if name == "tools_mcp_status":
                self.validate(arguments, helpers[name]["inputSchema"])
                try:
                    catalog = await self.discover()
                    result = {"state": "connected", "identity": catalog["identity"], "modules": catalog.get("modules", []), "nativeTools": len(self._discovery.get()[1]), "readOnly": self.settings.read_only, "uploadRoots": [str(x) for x in self.settings.upload_roots], "transport": "stdio-to-http-api"}
                except ConnectorError as error:
                    result = {"state": error.state, "message": str(error), "setup": "在终端运行 tools-mcp login 或 tools-mcp import-token；MCP进程不交互、不启动浏览器"}
                    return self.clean(result), True
            elif name in helpers:
                self.validate(arguments, helpers[name]["inputSchema"])
                if name == "tools_mcp_upload_file":
                    result = await self.upload(arguments)
                else:
                    result = await self.request_status(arguments["mcpRequestId"], retry=name == "tools_mcp_retry")
            else:
                request_id = arguments.get("mcpRequestId") if isinstance(arguments, dict) else None
                native_args = {k: v for k, v in arguments.items() if k != "mcpRequestId"} if isinstance(arguments, dict) else arguments
                result = await self.native(name, native_args, request_id)
            return self.clean(result), result.get("state") == "saved_verification_pending"
        except ConnectorError as error:
            return self.clean({"state": error.state, "message": str(error), **({"httpStatus": error.status} if error.status else {}), **({"mcpRequestId": arguments["mcpRequestId"]} if isinstance(arguments, dict) and arguments.get("mcpRequestId") else {})}), True
