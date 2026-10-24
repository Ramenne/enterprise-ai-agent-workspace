from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

API_BASE = "https://tools.example.invalid/agent/v1"
HUFU_BASE = "https://hufu.example.invalid/hub2-preview/hufu"


class ConnectorError(Exception):
    def __init__(self, message: str, *, state: str = "failed", status: int | None = None):
        super().__init__(message)
        self.state, self.status = state, status


def config_home() -> Path:
    return Path(os.environ.get("TOOLS_MCP_CONFIG_DIR", str(Path.home() / ".config" / "workspace-tools-mcp"))).expanduser().absolute()


def private_directory(path: Path) -> None:
    if path.is_symlink():
        raise ConnectorError("私有目录不能是符号链接")
    if not path.parent.exists():
        private_directory(path.parent)
    path.mkdir(exist_ok=True, mode=0o700)
    if os.name != "nt" and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ConnectorError("请为凭据和恢复记录选择仅本人可访问的私有目录（0700）")


def private_json(path: Path, value: dict) -> None:
    private_directory(path.parent)
    if path.is_symlink():
        raise ConnectorError("凭据文件不能是符号链接")
    temporary = path.with_name(path.name + ".tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temporary, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    os.replace(temporary, path)
    if os.name != "nt":
        os.chmod(path, 0o600)


def valid_base(value: str, allow_local: bool = False) -> str:
    parsed = urlsplit(value)
    local = allow_local and parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if (parsed.scheme != "https" and not local) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConnectorError("API地址必须是无凭据、无查询参数的HTTPS地址")
    if not parsed.path.rstrip("/").endswith("/agent/v1"):
        raise ConnectorError("API地址须以 /agent/v1 结尾")
    return value.rstrip("/")


@dataclass
class Settings:
    api_base: str = API_BASE
    credential_file: Path = field(default_factory=lambda: config_home() / "credentials.json")
    state_dir: Path = field(default_factory=lambda: config_home() / "state")
    upload_roots: tuple[Path, ...] = ()
    read_only: bool = False
    allow_local: bool = False
    token: str | None = None
    expected_actor: str | None = None

    def __post_init__(self) -> None:
        self.api_base = valid_base(self.api_base, self.allow_local)
        self.credential_file = self.credential_file.expanduser().absolute()
        self.state_dir = self.state_dir.expanduser().absolute()
        self.upload_roots = tuple(p.expanduser().resolve() for p in self.upload_roots)

    def credentials(self) -> dict:
        token = self.token or os.environ.get("TOOLS_MCP_TOKEN")
        if token:
            result = {"token": token, "actorId": self.expected_actor or os.environ.get("TOOLS_MCP_ACTOR_ID")}
        else:
            path = self.credential_file
            if not path.is_file():
                raise ConnectorError("尚未登录；请先在终端运行 tools-mcp login，或 tools-mcp import-token", state="authentication_required")
            if path.is_symlink() or (os.name != "nt" and stat.S_IMODE(path.stat().st_mode) & 0o077):
                raise ConnectorError("凭据文件只允许本人读写，请设置为0600")
            try:
                result = json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                raise ConnectorError("凭据文件格式无效，请重新登录") from None
            if not isinstance(result, dict):
                raise ConnectorError("凭据文件须为JSON对象")
            if result.get("apiBase") != self.api_base:
                raise ConnectorError("凭据绑定的TOOLS地址不匹配，拒绝转发凭据")
        if not isinstance(result.get("token"), str) or not result["token"] or len(result["token"]) > 4096 or any(c.isspace() for c in result["token"]):
            raise ConnectorError("成员凭据无效", state="authentication_required")
        return result
