#!/usr/bin/env python3
"""Resolve per-device log routing and install this skill into another project."""

import argparse
import json
import os
import platform
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


SKILL_DIR = Path(__file__).resolve().parent.parent
SKILL_NAME = "conversation-topic-logger"
CONFIG_FILE = Path.home() / ".conversation-topic-logger" / "config.json"
RULE_TEXT = """---
description: 每次用户发消息后执行 conversation-topic-logger
alwaysApply: true
---

每条用户消息都要在最终回复前读取并执行 `.agents/skills/conversation-topic-logger/SKILL.md`。
若日志路径缺失或无效，询问用户是否为当前设备配置新的日志目录；本轮无法写入时说明原因。
"""
AGENTS_BLOCK = """<!-- conversation-topic-logger:begin -->
## 对话日志

- 每条用户消息都要在最终回复前读取并执行 `.agents/skills/conversation-topic-logger/SKILL.md`。
- 若日志目录缺失或无效，询问用户是否为当前设备配置新目录；本轮无法写入时在最终回复中说明原因。
<!-- conversation-topic-logger:end -->
"""


def hostname():
    if platform.system() == "Darwin":
        try:
            result = subprocess.run(
                ["scutil", "--get", "LocalHostName"],
                capture_output=True,
                text=True,
                check=True,
            )
            value = result.stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            value = socket.gethostname()
    else:
        value = socket.gethostname()
    value = value.strip().lower()
    return value[:-6] if value.endswith(".local") else value


def config_file():
    override = os.environ.get("CONVERSATION_LOG_CONFIG_FILE")
    return Path(override).expanduser() if override else CONFIG_FILE


def read_json(path):
    try:
        with path.open("r", encoding="utf-8") as stream:
            data = json.load(stream)
    except json.JSONDecodeError as exc:
        raise ValueError(f"配置不是有效 JSON：{path}（{exc}）") from exc
    if not isinstance(data, dict):
        raise ValueError(f"配置不是 JSON 对象：{path}")
    return data


def validate_root(raw, check_write=True):
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("日志目录为空")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError(f"日志目录不是绝对路径：{raw}")
    path = path.resolve(strict=True)
    if not path.is_dir():
        raise ValueError(f"日志路径不是文件夹：{path}")
    if check_write:
        with tempfile.TemporaryFile(dir=path):
            pass
    return path


def resolve():
    host = hostname()
    env_root = os.environ.get("CONVERSATION_LOG_ROOT")
    routes = read_json(SKILL_DIR / "routes.json")
    mapping = routes.get("log_root_by_host", {})
    if not isinstance(mapping, dict):
        raise ValueError("routes.json 的 log_root_by_host 必须是对象")
    if env_root:
        source, raw = "environment", env_root
    elif routes.get("prefer_device_route") and mapping.get(host):
        source, raw = "bundled_host", mapping[host]
    elif config_file().exists():
        source, raw = "device", read_json(config_file()).get("log_root")
    else:
        source, raw = "bundled_host", mapping.get(host)
    if not raw:
        raise ValueError(f"设备 {host} 没有配置日志目录")
    try:
        path = validate_root(raw)
    except (OSError, ValueError) as exc:
        raise ValueError(f"设备 {host} 的日志目录无效（{source}: {raw}）：{exc}") from exc
    return {"host": host, "source": source, "log_root": str(path)}


def configure(path, create):
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        raise ValueError(f"日志目录不是绝对路径：{path}")
    if create:
        candidate.mkdir(parents=True, exist_ok=True)
    root = validate_root(str(candidate))
    location = config_file()
    current = read_json(location) if location.exists() else {}
    current["log_root"] = str(root)
    location.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=location.parent, delete=False) as stream:
        json.dump(current, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        temp_name = stream.name
    try:
        os.replace(temp_name, location)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return {"host": hostname(), "config_file": str(location), "log_root": str(root)}


PACKAGE_FILES = (
    "SKILL.md",
    "routes.json",
    "scripts/logger_setup.py",
)


def copy_skill(target, update):
    if target == SKILL_DIR:
        return
    if target.exists() and not update:
        if all((target / relative).is_file() and (target / relative).read_bytes() == (SKILL_DIR / relative).read_bytes()
               for relative in PACKAGE_FILES):
            return
        raise ValueError(f"Skill 已存在且内容不同：{target}；确认更新时加 --update")
    target.mkdir(parents=True, exist_ok=True)
    for relative in PACKAGE_FILES:
        source_file = SKILL_DIR / relative
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, destination)


def current_git_root():
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=Path.cwd(), capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if result.returncode != 0:
        raise ValueError("当前目录不在 Git 仓库中；请在目标仓库内运行，或使用 --repo 指定目录")
    return result.stdout.strip()


def git_root_and_common_dir(path):
    root = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    common = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "--git-common-dir"],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if root.returncode != 0 or common.returncode != 0:
        raise ValueError(f"目标不是 Git 仓库：{path}")
    repository = Path(root.stdout.strip()).resolve(strict=True)
    common_dir = Path(common.stdout.strip())
    if not common_dir.is_absolute():
        common_dir = (Path(path) / common_dir).resolve(strict=True)
    return repository, common_dir


def write_local_exclude(common_dir):
    exclude = common_dir / "info" / "exclude"
    start = "# conversation-topic-logger:begin"
    end = "# conversation-topic-logger:end"
    block = "\n".join((
        start,
        "/AGENTS.override.md",
        "/.agents/skills/conversation-topic-logger/",
        "/.cursor/rules/conversation-topic-logger.mdc",
        end,
    ))
    content = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
    if start in content:
        beginning = content.index(start)
        ending = content.index(end, beginning) + len(end)
        content = content[:beginning] + block + content[ending:]
    else:
        content = content.rstrip() + ("\n\n" if content.strip() else "") + block + "\n"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.write_text(content, encoding="utf-8")
    return exclude


def ensure_private_install(repository):
    tracked = subprocess.run(
        ["git", "-C", str(repository), "ls-files", "--", "AGENTS.override.md",
         ".agents/skills/conversation-topic-logger", ".cursor/rules/conversation-topic-logger.mdc"],
        capture_output=True, text=True, encoding="utf-8", check=True,
    )
    shared = tracked.stdout.splitlines()
    agents = repository / "AGENTS.md"
    if agents.is_file() and "conversation-topic-logger" in agents.read_text(encoding="utf-8-sig"):
        tracked_agents = subprocess.run(
            ["git", "-C", str(repository), "ls-files", "--", "AGENTS.md"],
            capture_output=True, text=True, encoding="utf-8", check=True,
        )
        if tracked_agents.stdout.strip():
            shared.append("AGENTS.md（含日志规则）")
    if shared:
        raise ValueError("仓库已跟踪个人日志配置，需先从 Git 索引移出并迁移到本地 override：" + "、".join(shared))


def register_global(home=None, update=False):
    base = Path.home() if home is None else Path(home)
    destinations = [
        base / ".codex" / "skills" / SKILL_NAME,
        base / ".cursor" / "skills" / SKILL_NAME,
    ]
    for target in destinations:
        copy_skill(target, update)
    return {"codex_skill": str(destinations[0]), "cursor_skill": str(destinations[1])}


def install(repo=None, update=False):
    requested = Path(repo or current_git_root()).expanduser().resolve(strict=True)
    repository, common_dir = git_root_and_common_dir(requested)
    ensure_private_install(repository)
    target = repository / ".agents" / "skills" / SKILL_NAME
    copy_skill(target, update)

    agents = repository / "AGENTS.override.md"
    content = agents.read_text(encoding="utf-8-sig") if agents.exists() else ""
    if "conversation-topic-logger:begin" in content:
        beginning = content.index("<!-- conversation-topic-logger:begin -->")
        ending_tag = "<!-- conversation-topic-logger:end -->"
        ending = content.index(ending_tag, beginning) + len(ending_tag)
        content = content[:beginning] + AGENTS_BLOCK.rstrip() + content[ending:]
    elif ".agents/skills/conversation-topic-logger/SKILL.md" not in content:
        content = content.rstrip() + ("\n\n" if content.strip() else "") + AGENTS_BLOCK
    agents.write_text(content.rstrip() + "\n", encoding="utf-8")

    rule = repository / ".cursor" / "rules" / f"{SKILL_NAME}.mdc"
    if not rule.exists() or update:
        rule.parent.mkdir(parents=True, exist_ok=True)
        rule.write_text(RULE_TEXT, encoding="utf-8")
    exclude = write_local_exclude(common_dir)
    return {"repository": str(repository), "skill": str(target), "agents_override": str(agents), "cursor_rule": str(rule), "git_exclude": str(exclude)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("resolve", help="解析并验证当前设备的日志目录")
    configure_parser = commands.add_parser("configure", help="设置当前设备的日志目录")
    configure_parser.add_argument("--path", required=True, help="日志根目录的绝对路径")
    configure_parser.add_argument("--create", action="store_true", help="明确要求创建该根目录")
    install_parser = commands.add_parser("install", help="为仓库安装本地 Skill、override 和强制触发规则")
    install_parser.add_argument("--repo", help="目标仓库根目录；省略时使用当前 Git 仓库")
    install_parser.add_argument("--update", action="store_true", help="更新已有的 Skill 和 Cursor 规则")
    register_parser = commands.add_parser("register", help="在本机注册 Codex 和 Cursor 用户级 Skill")
    register_parser.add_argument("--update", action="store_true", help="更新已有的用户级 Skill")
    args = parser.parse_args()
    try:
        if args.command == "resolve":
            result = resolve()
        elif args.command == "configure":
            result = configure(args.path, args.create)
        elif args.command == "install":
            result = install(args.repo, args.update)
        else:
            result = register_global(update=args.update)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        if args.command == "resolve":
            print("是否需要为这台设备指定一个新的日志目录？确认后运行 configure --path <绝对路径>。", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
