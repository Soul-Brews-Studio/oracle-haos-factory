"""Regression for upgrading aliases already written by v0.1.3–0.1.5."""
import json
from pathlib import Path
import re
import sqlite3
import unittest


class EntityMigrationTests(unittest.TestCase):
    def test_existing_category_parents_are_repaired_without_touching_messages_or_raw(self):
        migration = Path(__file__).parents[1] / "pb_migrations/1788669000_003_entity_parent_hierarchy.js"
        queries = [json.loads(text) for text in re.findall(r'newQuery\(("[^"\n]+")\)', migration.read_text())]
        self.assertEqual(len(queries), 2)
        with sqlite3.connect(":memory:") as db:
            db.executescript("""
                CREATE TABLE discord_entities (entity_id TEXT, kind TEXT, parent_id TEXT, guild_id TEXT, raw TEXT);
                CREATE TABLE discord_messages (message_id TEXT, content TEXT);
                INSERT INTO discord_entities VALUES ('channel', 'channel', 'category', 'guild', '{"parent_id":"category"}');
                INSERT INTO discord_entities VALUES ('thread', 'thread', 'channel', 'guild', '{}');
                INSERT INTO discord_entities VALUES ('guild', 'guild', 'bad-parent', 'guild', '{}');
                INSERT INTO discord_messages VALUES ('message', 'unchanged');
            """)
            for query in queries:
                db.execute(query)
            self.assertEqual(db.execute("SELECT parent_id, raw FROM discord_entities WHERE entity_id='channel'").fetchone(),
                             ('guild', '{"parent_id":"category"}'))
            self.assertEqual(db.execute("SELECT parent_id FROM discord_entities WHERE entity_id='thread'").fetchone(), ('channel',))
            self.assertEqual(db.execute("SELECT parent_id FROM discord_entities WHERE entity_id='guild'").fetchone(), ('',))
            self.assertEqual(db.execute("SELECT * FROM discord_messages").fetchall(), [('message', 'unchanged')])
