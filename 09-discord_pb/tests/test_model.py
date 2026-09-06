import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "dc_model.py"
spec = importlib.util.spec_from_file_location("dc_model", MODULE_PATH)
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)

G1, G2 = "10000000000000001", "10000000000000002"
C1, C2, C3, T1 = ("20000000000000001", "20000000000000002", "20000000000000003", "20000000000000004")


def entities():
    return [
        {"entity_id": G1, "kind": "guild", "name": "Mini lab", "guild_id": G1},
        {"entity_id": G2, "kind": "guild", "name": "Other Lab", "guild_id": G2},
        {"entity_id": C1, "kind": "channel", "name": "green-finance", "guild_id": G1, "parent_id": G1},
        {"entity_id": C2, "kind": "channel", "name": "arra-01", "guild_id": G1, "parent_id": G1},
        {"entity_id": T1, "kind": "thread", "name": "Budget Thread", "guild_id": G1, "parent_id": C1, "archived": True},
        {"entity_id": C3, "kind": "channel", "name": "Green Finance", "guild_id": G2, "parent_id": G2},
    ]


class DeclaredModelTests(unittest.TestCase):
    def test_resolves_exact_then_casefold_then_unique_substring_and_scopes_to_guild(self):
        configured = {
            "guilds": {"mini": {"channels": {
                "green-finance": {"import": True},
                "ARRA-01": {"post": True},
                "Budget": {"actions": ["archive"]},
            }}},
        }
        result = model.validate_model(configured, entities())
        self.assertEqual(set(result["config"]["guilds"]), {G1})
        self.assertEqual(set(result["config"]["guilds"][G1]["channels"]), {C1, C2, T1})
        self.assertTrue(result["channels"][C1]["import"])
        self.assertTrue(result["channels"][C2]["post"])
        self.assertEqual(result["channels"][T1]["actions"], ["archive"])
        self.assertEqual(result["channels"][C1]["name"], "green-finance")
        self.assertEqual(result["channels"][C1]["guild"], "Mini lab")

    def test_ambiguous_and_unknown_names_list_candidates(self):
        with self.assertRaises(model.ConfigError) as caught:
            model.validate_model({"oracles": {"reader": {"reads": ["green"]}}}, entities())
        self.assertIn("ambiguous channel", str(caught.exception))
        self.assertIn("green-finance", str(caught.exception))
        self.assertIn("Green Finance", str(caught.exception))
        with self.assertRaisesRegex(model.ConfigError, r"unknown channel 'missing'.*arra-01.*Budget Thread"):
            model.validate_model({"oracles": {"reader": {"reads": ["missing"]}}}, entities())

    def test_star_defaults_only_apply_inside_selected_guild_and_explicit_values_win(self):
        configured = {"guilds": {"Mini lab": {"purpose": "lab", "channels": {
            "*": {"import": True, "post": False, "owner": "default"},
            "arra-01": {"import": False, "actions": ["thread", "pin"]},
        }}}}
        result = model.validate_model(configured, entities())
        self.assertEqual(set(result["channels"]), {C1, C2, T1})
        self.assertTrue(result["channels"][C1]["import"])
        self.assertFalse(result["channels"][C2]["import"])
        self.assertEqual(result["channels"][C2]["owner"], "default")
        self.assertEqual(result["channels"][C2]["purpose"], "lab")
        self.assertNotIn(C3, result["channels"])

    def test_strict_types_unknown_keys_and_action_verbs(self):
        cases = [
            ({"extra": {}}, "unknown key"),
            ({"guilds": {"Mini lab": {"nope": True}}}, "unknown key"),
            ({"guilds": {"Mini lab": {"channels": {"*": {"import": 1}}}}}, "must be true or false"),
            ({"guilds": {"Mini lab": {"channels": {"*": {"actions": ["ban"]}}}}}, "unknown verb.*ban"),
            ({"oracles": {"x": {"reads": "green-finance"}}}, "must be a list"),
        ]
        for configured, message in cases:
            with self.subTest(configured=configured), self.assertRaisesRegex(model.ConfigError, message):
                model.validate_model(configured, entities())

    def test_actions_are_independent_from_post_permission(self):
        result = model.validate_model({"guilds": {"Mini lab": {"channels": {
            "arra-01": {"post": False, "actions": ["thread"]},
        }}}}, entities())
        self.assertFalse(result["channels"][C2]["post"])
        self.assertEqual(result["channels"][C2]["actions"], ["thread"])

    def test_import_rejects_unsupported_discord_types_explicitly_and_via_wildcard(self):
        unsupported = entities() + [
            {"entity_id": "20000000000000005", "kind": "channel", "name": "category", "guild_id": G1, "discord_type": 4},
            {"entity_id": "20000000000000006", "kind": "channel", "name": "forum", "guild_id": G1, "discord_type": 15},
            {"entity_id": "20000000000000007", "kind": "channel", "name": "media", "guild_id": G1, "discord_type": 16},
        ]
        for name, discord_type in (("category", 4), ("forum", 15), ("media", 16)):
            with self.subTest(explicit=name), self.assertRaisesRegex(
                    model.ConfigError, rf"{name!r}.*Discord type {discord_type}.*cannot import"):
                model.validate_model({"guilds": {"Mini lab": {"channels": {name: {"import": True}}}}}, unsupported)
        with self.assertRaisesRegex(model.ConfigError, r"Discord type (4|15|16).*cannot import"):
            model.validate_model({"guilds": {"Mini lab": {"channels": {"*": {"import": True}}}}}, unsupported)

    def test_import_allows_supported_thread_and_false_override_for_unsupported_rows(self):
        mixed = entities() + [
            {"entity_id": "20000000000000005", "kind": "channel", "name": "category", "guild_id": G1, "discord_type": 4},
        ]
        configured = {"guilds": {"Mini lab": {"channels": {
            "*": {"import": True}, "category": {"import": False}, "Budget Thread": {"import": True},
        }}}}
        result = model.validate_model(configured, mixed)
        self.assertTrue(result["channels"][T1]["import"])
        self.assertEqual(result["channels"][T1]["discord_type"], 11)
        self.assertFalse(result["channels"]["20000000000000005"]["import"])

    def test_yaml_rejects_duplicate_keys_aliases_and_oversize(self):
        with self.assertRaisesRegex(model.ConfigError, "duplicate YAML key"):
            model.parse_yaml("guilds: {}\nguilds: {}\n")
        with self.assertRaisesRegex(model.ConfigError, "aliases are not allowed"):
            model.parse_yaml("guilds: &g {}\noracles: *g\n")
        with self.assertRaisesRegex(model.ConfigError, "exceeds"):
            model.parse_yaml("#" * (model.MAX_YAML_BYTES + 1))

    def test_save_canonicalizes_refs_atomically_and_round_trips(self):
        raw = """guilds:\n  Mini lab:\n    channels:\n      green-finance: {import: true, post: true, actions: [pin]}\noracles:\n  greenfin-oracle: {home: [green-finance], reads: [arra-01]}\n"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dc.config.yaml"
            saved = model.save_config(raw_yaml=raw, entities=entities(), path=path)
            self.assertTrue(saved["ok"])
            self.assertIn(G1, saved["config"]["guilds"])
            self.assertIn(C1, saved["config"]["guilds"][G1]["channels"])
            self.assertEqual(saved["oracles"]["greenfin-oracle"]["home"], [C1])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            loaded = model.load_config(path, entities())
            self.assertTrue(loaded["ok"])
            self.assertEqual(loaded["config"], saved["config"])
            self.assertEqual(loaded["channels"][C1]["name"], "green-finance")

    def test_invalid_existing_file_fails_closed_and_is_not_overwritten_by_set(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dc.config.yaml"
            original = "guilds:\n  Mini lab:\n    channels:\n      '*': {actions: [destroy]}\n"
            path.write_text(original)
            loaded = model.load_config(path, entities())
            self.assertFalse(loaded["ok"])
            self.assertEqual(loaded["channels"], {})
            changed = model.set_channel(C1, {"import": True}, entities(), path=path)
            self.assertFalse(changed["ok"])
            self.assertEqual(path.read_text(), original)

    def test_discovery_returns_raw_guild_refs_before_entities_exist(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dc.config.yaml"
            path.write_text("guilds:\n  Mini lab: {channels: {}}\n  '10000000000000002': {channels: {}}\n")
            self.assertEqual(model.discovery_guilds(path), ["Mini lab", G2])
            path.write_text("guilds:\n  Mini lab: {channels: {'*': {actions: [explode]}}}\n")
            with self.assertRaisesRegex(model.ConfigError, "unknown verb"):
                model.discovery_guilds(path)

    def test_missing_config_is_safe_empty_model(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.yaml"
            result = model.load_config(path, entities())
            self.assertTrue(result["ok"])
            self.assertFalse(result["exists"])
            self.assertEqual(result["channels"], {})
            self.assertEqual(model.discovery_guilds(path), [])

    def test_set_preserves_declared_model_and_oracles(self):
        original = {"guilds": {"Mini lab": {"channels": {"green-finance": {"post": True}}}},
                    "oracles": {"arra": {"home": ["arra-01"], "reads": []}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dc.config.yaml"
            self.assertTrue(model.save_config(config=original, entities=entities(), path=path)["ok"])
            changed = model.set_channel(T1, {"purpose": "history", "import": True, "actions": ["archive"]},
                                        entities(), path=path)
            self.assertTrue(changed["ok"])
            self.assertEqual(set(changed["config"]["guilds"]), {G1})
            self.assertEqual(set(changed["config"]["guilds"][G1]["channels"]), {C1, T1})
            self.assertTrue(changed["channels"][C1]["post"])
            self.assertTrue(changed["channels"][T1]["import"])
            self.assertEqual(changed["channels"][T1]["actions"], ["archive"])
            self.assertEqual(changed["oracles"]["arra"]["home"], [C2])

    def test_set_rejects_channel_without_known_guild_cleanly(self):
        broken = entities() + [{"entity_id": "20000000000000009", "kind": "channel", "name": "orphan",
                                "guild_id": "10000000000000009"}]
        with tempfile.TemporaryDirectory() as directory:
            result = model.set_channel("20000000000000009", {"import": True}, broken,
                                       path=Path(directory) / "dc.config.yaml")
            self.assertFalse(result["ok"])
            self.assertIn("references unknown guild id", result["error"])

    def test_normalized_object_is_bounded_even_without_raw_yaml(self):
        result = model.validate_config(config={"oracles": {"huge": {"voice": "x" * model.MAX_YAML_BYTES}}},
                                       entities=entities())
        self.assertFalse(result["ok"])
        self.assertIn("normalized config YAML exceeds", result["error"])

    def test_set_on_missing_seeds_initial_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dc.config.yaml"
            changed = model.set_channel(C2, {"purpose": "agent room"}, entities(), path=path, selected_ids=[C1])
            self.assertTrue(changed["ok"])
            self.assertTrue(changed["channels"][C1]["import"])
            self.assertFalse(changed["channels"][C2]["import"])
            self.assertEqual(changed["channels"][C2]["purpose"], "agent room")

    def test_set_preserves_wildcard_for_channels_discovered_later(self):
        original = {"guilds": {"Mini lab": {"channels": {"*": {"import": True, "post": False}}}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dc.config.yaml"
            self.assertTrue(model.save_config(config=original, entities=entities(), path=path)["ok"])
            changed = model.set_channel(C2, {"purpose": "agent room"}, entities(), path=path)
            self.assertTrue(changed["ok"])
            declared = changed["config"]["guilds"][G1]["channels"]
            self.assertEqual(set(declared), {"*", C2})
            self.assertTrue(declared["*"]["import"])
            later = entities() + [{"entity_id": "20000000000000005", "kind": "thread", "name": "Later",
                                   "guild_id": G1, "parent_id": C1}]
            reloaded = model.load_config(path, later)
            self.assertTrue(reloaded["channels"]["20000000000000005"]["import"])

    def test_two_request_file_set_processes_preserve_both_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dc.config.yaml"
            env = dict(os.environ, DC_CONFIG_PATH=str(path))
            requests = []
            for entity_id, purpose in ((C1, "research"), (C2, "agent room")):
                request_file = Path(directory) / f"{entity_id}.json"
                request_file.write_text(json.dumps({"operation": "set", "entities": entities(),
                                                     "entity_id": entity_id, "changes": {"purpose": purpose}}))
                request_file.chmod(0o600)
                requests.append(request_file)
            processes = [subprocess.Popen([sys.executable, str(MODULE_PATH), "--request-file", str(request_file)],
                                          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
                         for request_file in requests]
            outputs = [process.communicate(timeout=10) for process in processes]
            for process, (stdout, stderr) in zip(processes, outputs):
                self.assertEqual(process.returncode, 0, stderr)
                self.assertTrue(json.loads(stdout)["ok"])
            loaded = model.load_config(path, entities())
            self.assertEqual(loaded["channels"][C1]["purpose"], "research")
            self.assertEqual(loaded["channels"][C2]["purpose"], "agent room")

    def test_cli_json_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dc.config.yaml"
            request = {"operation": "save", "entities": entities(), "config": {
                "guilds": {"Mini lab": {"channels": {"arra-01": {"import": True}}}}
            }}
            env = dict(os.environ, DC_CONFIG_PATH=str(path))
            result = subprocess.run([sys.executable, str(MODULE_PATH)], input=json.dumps(request), text=True,
                                    capture_output=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["channels"][C2]["import"])
            bad = subprocess.run([sys.executable, str(MODULE_PATH)], input='{"operation":"wat"}', text=True,
                                 capture_output=True, env=env)
            self.assertEqual(bad.returncode, 1)
            self.assertIn("operation must be", json.loads(bad.stdout)["error"])

            request_file = Path(directory) / "request.json"
            request_file.write_text(json.dumps({"operation": "get", "entities": entities()}))
            request_file.chmod(0o600)
            via_file = subprocess.run([sys.executable, str(MODULE_PATH), "--request-file", str(request_file)],
                                      text=True, capture_output=True, env=env)
            self.assertEqual(via_file.returncode, 0, via_file.stderr)
            self.assertTrue(json.loads(via_file.stdout)["ok"])
            request_file.chmod(0o644)
            insecure = subprocess.run([sys.executable, str(MODULE_PATH), "--request-file", str(request_file)],
                                      text=True, capture_output=True, env=env)
            self.assertEqual(insecure.returncode, 0)
            insecure_payload = json.loads(insecure.stdout)
            self.assertFalse(insecure_payload["ok"])
            self.assertIn("group or others", insecure_payload["error"])


if __name__ == "__main__":
    unittest.main()
