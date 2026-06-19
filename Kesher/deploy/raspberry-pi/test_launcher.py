import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("kesher-pi-launcher.py")
SPEC = importlib.util.spec_from_file_location("kesher_pi_launcher", MODULE_PATH)
launcher = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "server_url": "http://192.168.1.10:8080",
            "clients": [
                {
                    "ip_address": "192.168.1.51",
                    "name": "FOH",
                    "role_id": "audio",
                    "audio_input_match": "USB Audio",
                }
            ],
        }

    def test_resolves_station_from_local_ip(self):
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        self.assertEqual(client["name"], "FOH")
        self.assertEqual(client["role_id"], "audio")

    def test_builds_encoded_auto_login_url(self):
        client = launcher.resolve_client(self.config, ["192.168.1.51"])
        url = launcher.build_kesher_url(self.config["server_url"], client)
        self.assertIn("autoLogin=1", url)
        self.assertIn("autoTakeover=1", url)
        self.assertIn("roleId=audio", url)
        self.assertIn("audioInputMatch=USB+Audio", url)

    def test_rejects_unknown_pi(self):
        with self.assertRaisesRegex(ValueError, "no client entry matches"):
            launcher.resolve_client(self.config, ["192.168.1.99"])

    def test_rejects_duplicate_ip(self):
        self.config["clients"].append(dict(self.config["clients"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate client IP"):
            launcher.resolve_client(self.config, ["192.168.1.51"])


if __name__ == "__main__":
    unittest.main()
