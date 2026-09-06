#!/usr/bin/env python3
"""Strict declared Discord channel model backed by /data/dc.config.yaml."""

from __future__ import annotations

import copy
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from typing import Any

import yaml


CONFIG_PATH = os.getenv("DC_CONFIG_PATH", "/data/dc.config.yaml")
MAX_YAML_BYTES = 128 * 1024
MAX_REQUEST_BYTES = 8 * 1024 * 1024
ACTION_VERBS = frozenset({"thread", "pin", "archive"})
IMPORTABLE_TYPES = frozenset({0, 5, 10, 11, 12})
TOP_KEYS = frozenset({"guilds", "oracles"})
GUILD_KEYS = frozenset({"purpose", "channels"})
CHANNEL_KEYS = frozenset({"purpose", "owner", "import", "post", "actions"})
ORACLE_KEYS = frozenset({"home", "reads", "voice"})


class ConfigError(ValueError):
    """A user-actionable declared-model validation error."""


class StrictLoader(yaml.SafeLoader):
    pass


def _compose_node_without_aliases(self, parent, index):
    if self.check_event(yaml.AliasEvent):
        raise ConfigError("YAML aliases are not allowed")
    return yaml.SafeLoader.compose_node(self, parent, index)


def _construct_unique_mapping(self, node, deep=False):
    self.flatten_mapping(node)
    result = {}
    for key_node, value_node in node.value:
        key = self.construct_object(key_node, deep=deep)
        try:
            duplicate = key in result
        except TypeError as error:
            raise ConfigError("YAML mapping keys must be scalar values") from error
        if duplicate:
            raise ConfigError(f"duplicate YAML key {key!r} at line {key_node.start_mark.line + 1}")
        result[key] = self.construct_object(value_node, deep=deep)
    return result


StrictLoader.compose_node = _compose_node_without_aliases
StrictLoader.construct_mapping = _construct_unique_mapping


def _empty_model() -> dict[str, Any]:
    return {"guilds": {}, "oracles": {}}


def parse_yaml(text: str) -> dict[str, Any]:
    if not isinstance(text, str):
        raise ConfigError("config YAML must be text")
    if len(text.encode("utf-8")) > MAX_YAML_BYTES:
        raise ConfigError(f"config YAML exceeds {MAX_YAML_BYTES} bytes")
    try:
        value = yaml.load(text, Loader=StrictLoader)
    except ConfigError:
        raise
    except yaml.YAMLError as error:
        problem = getattr(error, "problem", None) or str(error).splitlines()[0]
        mark = getattr(error, "problem_mark", None)
        where = f" at line {mark.line + 1}, column {mark.column + 1}" if mark else ""
        raise ConfigError(f"invalid YAML{where}: {problem}") from error
    if value is None:
        return _empty_model()
    if not isinstance(value, dict):
        raise ConfigError("config root must be a mapping")
    return value


def _mapping(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{path} must be a mapping")
    if any(not isinstance(key, str) or not key for key in value):
        raise ConfigError(f"{path} keys must be non-empty strings")
    return value


def _keys(value: dict[str, Any], allowed: frozenset[str], path: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigError(f"{path} has unknown key(s): {', '.join(unknown)}")


def _optional_string(value: Any, path: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ConfigError(f"{path} must be a string")
    return value


def _policy(value: Any, path: str) -> dict[str, Any]:
    value = _mapping(value, path)
    _keys(value, CHANNEL_KEYS, path)
    result: dict[str, Any] = {}
    for key in ("purpose", "owner"):
        if key in value:
            result[key] = _optional_string(value[key], f"{path}.{key}")
    for key in ("import", "post"):
        if key in value:
            if type(value[key]) is not bool:
                raise ConfigError(f"{path}.{key} must be true or false")
            result[key] = value[key]
    if "actions" in value:
        actions = value["actions"]
        if not isinstance(actions, list) or any(not isinstance(item, str) for item in actions):
            raise ConfigError(f"{path}.actions must be a list of action verbs")
        unknown = sorted(set(actions) - ACTION_VERBS)
        if unknown:
            raise ConfigError(
                f"{path}.actions has unknown verb(s): {', '.join(unknown)}; "
                f"allowed: {', '.join(sorted(ACTION_VERBS))}"
            )
        if len(actions) != len(set(actions)):
            raise ConfigError(f"{path}.actions contains duplicate verbs")
        result["actions"] = list(actions)
    return result


def _entity_index(entities: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not isinstance(entities, list):
        raise ConfigError("entities must be a list")
    guilds, channels, seen = [], [], set()
    for index, raw in enumerate(entities):
        if not isinstance(raw, dict):
            raise ConfigError(f"entities[{index}] must be an object")
        entity_id, kind, name = raw.get("entity_id"), raw.get("kind"), raw.get("name")
        if not all(isinstance(item, str) and item for item in (entity_id, kind, name)):
            raise ConfigError(f"entities[{index}] is missing entity_id, kind, or name")
        if entity_id in seen:
            raise ConfigError(f"duplicate entity_id {entity_id!r}")
        seen.add(entity_id)
        item = {
            "entity_id": entity_id,
            "kind": kind,
            "name": name,
            "guild_id": raw.get("guild_id") or (entity_id if kind == "guild" else ""),
            "parent_id": raw.get("parent_id") or "",
            "archived": bool(raw.get("archived", False)),
            "discord_type": raw.get("discord_type", 11 if kind == "thread" else 0),
        }
        if type(item["discord_type"]) is not int:
            raise ConfigError(f"entities[{index}].discord_type must be an integer")
        if kind == "guild":
            guilds.append(item)
        elif kind in {"channel", "thread"}:
            channels.append(item)
    return guilds, channels


def _candidates(rows: list[dict[str, Any]]) -> str:
    return ", ".join(f"{row['name']} ({row['entity_id']})" for row in sorted(rows, key=lambda x: (x["name"].casefold(), x["entity_id"]))) or "none"


def resolve_ref(ref: str, rows: list[dict[str, Any]], kind: str) -> dict[str, Any]:
    if not isinstance(ref, str) or not ref:
        raise ConfigError(f"{kind} reference must be a non-empty string")
    by_id = [row for row in rows if row["entity_id"] == ref]
    if by_id:
        return by_id[0]
    tiers = [
        [row for row in rows if row["name"] == ref],
        [row for row in rows if row["name"].casefold() == ref.casefold()],
        [row for row in rows if ref.casefold() in row["name"].casefold()],
    ]
    for matches in tiers:
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ConfigError(f"ambiguous {kind} {ref!r}; candidates: {_candidates(matches)}")
    raise ConfigError(f"unknown {kind} {ref!r}; candidates: {_candidates(rows)}")


def _merge_policy(*parts: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"purpose": None, "owner": None, "import": False, "post": False, "actions": []}
    for part in parts:
        result.update(part)
    result["actions"] = list(result["actions"])
    return result


def validate_structure(config: Any) -> dict[str, Any]:
    """Validate schema and scalar types without resolving entity references."""
    config = _mapping(config, "config")
    _keys(config, TOP_KEYS, "config")
    guild_specs = _mapping(config.get("guilds", {}), "guilds")
    oracle_specs = _mapping(config.get("oracles", {}), "oracles")
    for guild_ref, raw_guild in guild_specs.items():
        raw_guild = _mapping(raw_guild, f"guilds.{guild_ref}")
        _keys(raw_guild, GUILD_KEYS, f"guilds.{guild_ref}")
        _optional_string(raw_guild.get("purpose"), f"guilds.{guild_ref}.purpose")
        channel_specs = _mapping(raw_guild.get("channels", {}), f"guilds.{guild_ref}.channels")
        for channel_ref, raw_policy in channel_specs.items():
            _policy(raw_policy, f"guilds.{guild_ref}.channels.{channel_ref}")
    for oracle_name, raw_oracle in oracle_specs.items():
        raw_oracle = _mapping(raw_oracle, f"oracles.{oracle_name}")
        _keys(raw_oracle, ORACLE_KEYS, f"oracles.{oracle_name}")
        for field in ("home", "reads"):
            refs = raw_oracle.get(field, [])
            if not isinstance(refs, list) or any(not isinstance(ref, str) or not ref for ref in refs):
                raise ConfigError(f"oracles.{oracle_name}.{field} must be a list of channel names or ids")
        if "voice" in raw_oracle:
            _optional_string(raw_oracle["voice"], f"oracles.{oracle_name}.voice")
    return config


def discovery_guilds(path: str | os.PathLike[str] = CONFIG_PATH) -> list[str]:
    """Return declared guild refs before discovery; invalid existing files fail closed."""
    candidate = Path(path)
    if not candidate.exists():
        return []
    try:
        raw = candidate.read_bytes()
        if len(raw) > MAX_YAML_BYTES:
            raise ConfigError(f"config YAML exceeds {MAX_YAML_BYTES} bytes")
        config = validate_structure(parse_yaml(raw.decode("utf-8")))
    except UnicodeDecodeError as error:
        raise ConfigError("config YAML must be UTF-8") from error
    return list(config.get("guilds", {}).keys())


def validate_model(config: Any, entities: Any) -> dict[str, Any]:
    """Validate and resolve a model; canonical config binds all references to IDs."""
    config = validate_structure(config)
    guild_rows, channel_rows = _entity_index(entities)
    guild_specs = _mapping(config.get("guilds", {}), "guilds")
    oracle_specs = _mapping(config.get("oracles", {}), "oracles")
    canonical: dict[str, Any] = {"guilds": {}, "oracles": {}}
    resolved: dict[str, Any] = {}

    chosen_guilds: set[str] = set()
    for guild_ref, raw_guild in guild_specs.items():
        guild = resolve_ref(guild_ref, guild_rows, "guild")
        gid = guild["entity_id"]
        if gid in chosen_guilds:
            raise ConfigError(f"guild {guild_ref!r} resolves to duplicate guild id {gid}")
        chosen_guilds.add(gid)
        raw_guild = _mapping(raw_guild, f"guilds.{guild_ref}")
        _keys(raw_guild, GUILD_KEYS, f"guilds.{guild_ref}")
        purpose = _optional_string(raw_guild.get("purpose"), f"guilds.{guild_ref}.purpose")
        channel_specs = _mapping(raw_guild.get("channels", {}), f"guilds.{guild_ref}.channels")
        scoped = [row for row in channel_rows if row["guild_id"] == gid]
        default = _policy(channel_specs.get("*", {}), f"guilds.{guild_ref}.channels.*") if "*" in channel_specs else {}
        explicit: dict[str, dict[str, Any]] = {}
        canonical_channels: dict[str, Any] = {}
        if "*" in channel_specs:
            canonical_channels["*"] = default
        for channel_ref, raw_policy in channel_specs.items():
            if channel_ref == "*":
                continue
            channel = resolve_ref(channel_ref, scoped, f"channel in guild {guild['name']!r}")
            cid = channel["entity_id"]
            if cid in explicit:
                raise ConfigError(f"channel {channel_ref!r} resolves to duplicate channel id {cid}")
            explicit[cid] = _policy(raw_policy, f"guilds.{guild_ref}.channels.{channel_ref}")
            canonical_channels[cid] = explicit[cid]
        canonical_guild: dict[str, Any] = {"channels": canonical_channels}
        if purpose is not None:
            canonical_guild["purpose"] = purpose
        canonical["guilds"][gid] = canonical_guild
        for row in scoped:
            policy = _merge_policy({"purpose": purpose}, default, explicit.get(row["entity_id"], {}))
            if policy["import"] and row["discord_type"] not in IMPORTABLE_TYPES:
                raise ConfigError(
                    f"channel {row['name']!r} ({row['entity_id']}) has Discord type "
                    f"{row['discord_type']}, which cannot import messages; supported types: "
                    f"{', '.join(str(item) for item in sorted(IMPORTABLE_TYPES))}"
                )
            resolved[row["entity_id"]] = {
                "id": row["entity_id"], "name": row["name"], "kind": row["kind"],
                "guild_id": gid, "guild": guild["name"], "parent": row["parent_id"],
                "archived": row["archived"], **policy,
                "discord_type": row["discord_type"],
            }

    for oracle_name, raw_oracle in oracle_specs.items():
        raw_oracle = _mapping(raw_oracle, f"oracles.{oracle_name}")
        _keys(raw_oracle, ORACLE_KEYS, f"oracles.{oracle_name}")
        item: dict[str, Any] = {}
        for field in ("home", "reads"):
            refs = raw_oracle.get(field, [])
            if not isinstance(refs, list) or any(not isinstance(ref, str) or not ref for ref in refs):
                raise ConfigError(f"oracles.{oracle_name}.{field} must be a list of channel names or ids")
            ids = [resolve_ref(ref, channel_rows, "channel")["entity_id"] for ref in refs]
            if len(ids) != len(set(ids)):
                raise ConfigError(f"oracles.{oracle_name}.{field} resolves to duplicate channels")
            item[field] = ids
        if "voice" in raw_oracle:
            item["voice"] = _optional_string(raw_oracle["voice"], f"oracles.{oracle_name}.voice")
        canonical["oracles"][oracle_name] = item

    return {"config": canonical, "channels": resolved, "oracles": canonical["oracles"]}


def dump_yaml(config: dict[str, Any]) -> str:
    return yaml.safe_dump(config, allow_unicode=True, sort_keys=False, default_flow_style=False)


def _result(resolved: dict[str, Any], exists: bool) -> dict[str, Any]:
    text = dump_yaml(resolved["config"])
    if len(text.encode("utf-8")) > MAX_YAML_BYTES:
        raise ConfigError(f"normalized config YAML exceeds {MAX_YAML_BYTES} bytes")
    return {"ok": True, "exists": exists, **resolved, "yaml": text}


def _error_result(error: Exception, exists: bool) -> dict[str, Any]:
    return {"ok": False, "exists": exists, "config": _empty_model(), "channels": {}, "oracles": {}, "yaml": "", "error": str(error)}


def load_config(path: str | os.PathLike[str] = CONFIG_PATH, entities: Any = None) -> dict[str, Any]:
    candidate = Path(path)
    if not candidate.exists():
        try:
            return _result(validate_model(_empty_model(), entities or []), False)
        except ConfigError as error:
            return _error_result(error, False)
    try:
        raw = candidate.read_bytes()
        if len(raw) > MAX_YAML_BYTES:
            raise ConfigError(f"config YAML exceeds {MAX_YAML_BYTES} bytes")
        return _result(validate_model(parse_yaml(raw.decode("utf-8")), entities or []), True)
    except (ConfigError, OSError, UnicodeDecodeError) as error:
        return _error_result(error, True)


def _atomic_write(path: str | os.PathLike[str], text: str) -> None:
    candidate = Path(path)
    candidate.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{candidate.name}.", dir=candidate.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, candidate)
        directory_fd = os.open(candidate.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


@contextmanager
def _config_lock(path: str | os.PathLike[str]):
    lock_path = Path(path).with_name(f".{Path(path).name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def validate_config(*, raw_yaml: str | None = None, config: Any = None, entities: Any = None) -> dict[str, Any]:
    try:
        if (raw_yaml is None) == (config is None):
            raise ConfigError("provide exactly one of yaml or config")
        model = parse_yaml(raw_yaml) if raw_yaml is not None else config
        return _result(validate_model(model, entities or []), False)
    except ConfigError as error:
        return _error_result(error, False)


def save_config(*, raw_yaml: str | None = None, config: Any = None, entities: Any = None,
                path: str | os.PathLike[str] = CONFIG_PATH) -> dict[str, Any]:
    result = validate_config(raw_yaml=raw_yaml, config=config, entities=entities)
    if not result["ok"]:
        return result
    try:
        with _config_lock(path):
            _atomic_write(path, result["yaml"])
    except OSError as error:
        return _error_result(error, Path(path).exists())
    result["exists"] = True
    return result


def _seed_config(entities: Any, current: dict[str, Any], selected_ids: set[str], target: dict[str, Any]) -> dict[str, Any]:
    guild_rows, channel_rows = _entity_index(entities)
    by_gid = {row["entity_id"]: row for row in guild_rows}
    if not target["guild_id"]:
        raise ConfigError(f"channel {target['entity_id']} has no guild_id")
    if target["guild_id"] not in by_gid:
        raise ConfigError(f"channel {target['entity_id']} references unknown guild id {target['guild_id']}")
    config = copy.deepcopy(current.get("config", _empty_model()))
    config.setdefault("guilds", {})
    config.setdefault("oracles", {})
    if current.get("exists"):
        return config

    # The legacy channels option becomes only the initial explicit selection.
    # Wildcard false preserves a reviewable default for channels discovered later.
    by_channel = {row["entity_id"]: row for row in channel_rows}
    seed_ids = set(selected_ids) | {target["entity_id"]}
    for cid in sorted(seed_ids):
        row = by_channel.get(cid)
        if row is None:
            if cid in selected_ids:
                raise ConfigError(f"initially selected channel id {cid!r} is unknown")
            continue
        gid = row["guild_id"]
        if not gid:
            raise ConfigError(f"channel {cid} has no guild_id")
        if gid not in by_gid:
            raise ConfigError(f"channel {cid} references unknown guild id {gid}")
        guild = config["guilds"].setdefault(gid, {"channels": {"*": {"import": False, "post": False, "actions": []}}})
        guild.setdefault("channels", {}).setdefault("*", {"import": False, "post": False, "actions": []})
        if cid in selected_ids:
            guild["channels"][cid] = {"import": True}
    return config


def set_channel(entity_id: str, changes: Any, entities: Any, *, path: str | os.PathLike[str] = CONFIG_PATH,
                selected_ids: Any = None) -> dict[str, Any]:
    try:
        if not isinstance(entity_id, str) or not entity_id:
            raise ConfigError("entity_id must be a non-empty string")
        changes = _policy(changes, "changes")
        _, channel_rows = _entity_index(entities)
        target = next((row for row in channel_rows if row["entity_id"] == entity_id), None)
        if target is None:
            raise ConfigError(f"unknown channel id {entity_id!r}; candidates: {_candidates(channel_rows)}")
        selected = set(selected_ids or [])
        with _config_lock(path):
            current = load_config(path, entities)
            if current["exists"] and not current["ok"]:
                return current
            configured = _seed_config(entities, current, selected, target)
            guild = configured["guilds"].setdefault(
                target["guild_id"], {"channels": {"*": {"import": False, "post": False, "actions": []}}}
            )
            declared = guild.setdefault("channels", {})
            effective = current.get("channels", {}).get(target["entity_id"], {})
            base = {key: copy.deepcopy(effective.get(key, default)) for key, default in (
                ("purpose", None), ("owner", None), ("import", target["entity_id"] in selected),
                ("post", False), ("actions", []),
            )}
            base.update(changes)
            declared[target["entity_id"]] = base
            result = validate_config(config=configured, entities=entities)
            if not result["ok"]:
                return result
            _atomic_write(path, result["yaml"])
            result["exists"] = True
            return result
    except (ConfigError, OSError) as error:
        return _error_result(error, Path(path).exists())


def _read_request(argv: list[str]) -> Any:
    if not argv:
        return json.load(sys.stdin)
    if len(argv) != 2 or argv[0] != "--request-file":
        raise ConfigError("usage: dc_model.py [--request-file PATH]")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(argv[1], flags)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise ConfigError("request file must be a regular file")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise ConfigError("request file must not be accessible by group or others")
        if metadata.st_size > MAX_REQUEST_BYTES:
            raise ConfigError(f"request JSON exceeds {MAX_REQUEST_BYTES} bytes")
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            fd = -1
            return json.load(stream)
    finally:
        if fd >= 0:
            os.close(fd)


def cli_main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    request_file_transport = len(arguments) == 2 and arguments[0] == "--request-file"
    try:
        request = _read_request(arguments)
        if not isinstance(request, dict):
            raise ConfigError("request must be a JSON object")
        operation = request.get("operation")
        entities = request.get("entities", [])
        path = os.getenv("DC_CONFIG_PATH", CONFIG_PATH)
        if operation in {"get", "reload"}:
            result = load_config(path, entities)
        elif operation == "discover":
            result = {"ok": True, "exists": Path(path).exists(), "guilds": discovery_guilds(path)}
        elif operation == "validate":
            result = validate_config(raw_yaml=request.get("yaml") if "yaml" in request else None,
                                     config=request.get("config") if "config" in request else None, entities=entities)
        elif operation == "save":
            result = save_config(raw_yaml=request.get("yaml") if "yaml" in request else None,
                                 config=request.get("config") if "config" in request else None,
                                 entities=entities, path=path)
        elif operation == "set":
            result = set_channel(request.get("entity_id"), request.get("changes"), entities, path=path,
                                 selected_ids=request.get("selected", []))
        else:
            raise ConfigError("operation must be one of: discover, get, reload, validate, save, set")
    except (ConfigError, json.JSONDecodeError, OSError) as error:
        result = _error_result(error, Path(os.getenv("DC_CONFIG_PATH", CONFIG_PATH)).exists())
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    # PB's $os.cmd(...).output() throws on non-zero and would hide the structured
    # validation error. A valid request-file invocation therefore uses exit zero
    # as transport success; callers inspect result.ok. Interactive stdin retains
    # conventional non-zero validation status.
    return 0 if result["ok"] or request_file_transport else 1


if __name__ == "__main__":
    raise SystemExit(cli_main())
