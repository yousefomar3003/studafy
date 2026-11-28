import sys
import tempfile
import threading
import unittest

import _support  # noqa: F401  (loads erpnext_agent)
from _support import SECRETS

from erpnext_agent.config import Config, ConfigError
from erpnext_agent.redact import Redactor, error_message
from erpnext_agent.runner import Runner, StopFlag

ENV = {
    "STUDAFY_API_URL": "https://api.studafy.com",
    "ERPNEXT_AGENT_TOKEN": SECRETS["agent_token"],
    "MARIADB_ROOT_PASSWORD": SECRETS["mariadb_root_password"],
    "ERPNEXT_ADMIN_PASSWORD": SECRETS["admin_password"],
    "STUDAFY_ERPNEXT_API_KEY": SECRETS["erpnext_api_key"],
    "STUDAFY_ERPNEXT_WEBHOOK_SECRET": SECRETS["webhook_secret"],
}


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_captures_output_and_exit_code(self):
        code = "import sys; print('out'); print('err', file=sys.stderr); sys.exit(3)"
        result = Runner(StopFlag()).run([sys.executable, "-c", code], cwd=self.tmp.name, timeout=30)
        self.assertEqual((result.returncode, result.stdout.strip(), result.stderr.strip()), (3, "out", "err"))
        self.assertFalse(result.ok)
        self.assertEqual(result.output, "err")

    def test_timeout_kills_the_command(self):
        result = Runner(StopFlag(), grace=1).run(
            [sys.executable, "-c", "import time; time.sleep(60)"], cwd=self.tmp.name, timeout=0.5
        )
        self.assertTrue(result.timed_out)
        self.assertFalse(result.ok)
        self.assertLess(result.duration, 10)

    def test_stop_interrupts_only_interruptible_commands(self):
        stop = StopFlag()
        threading.Timer(0.3, stop.set).start()
        result = Runner(stop, grace=1).run(
            [sys.executable, "-c", "import time; time.sleep(60)"], cwd=self.tmp.name, timeout=30, interruptible=True
        )
        self.assertTrue(result.interrupted)
        self.assertLess(result.duration, 10)

        short = Runner(stop).run(
            [sys.executable, "-c", "import time; time.sleep(0.3); print('done')"], cwd=self.tmp.name, timeout=30
        )
        self.assertTrue(short.ok)
        self.assertEqual(short.stdout.strip(), "done")

    def test_missing_binary_is_a_failure_not_an_exception(self):
        result = Runner(StopFlag()).run(["/nonexistent/bench"], cwd=self.tmp.name, timeout=5)
        self.assertIsNone(result.returncode)
        self.assertIn("could not start bench", result.output)


class RedactTest(unittest.TestCase):
    def test_scrubs_before_truncating(self):
        redact = Redactor(["s3cr3t-value"])
        message = error_message(redact, "step failed", "a" * 3000 + "s3cr3t-value", limit=100)
        self.assertLessEqual(len(message), 100)
        self.assertNotIn("s3cr3t", message)
        self.assertTrue(message.endswith("[redacted]"))

    def test_scrubs_url_encoded_form(self):
        redact = Redactor(["p@ss word"])
        self.assertEqual(redact("x p%40ss%20word y p@ss word"), "x [redacted] y [redacted]")

    def test_single_pass_never_rescans_the_marker(self):
        # "dact" is inside "[redacted]"; a naive replace loop would shred the marker.
        self.assertEqual(Redactor(["dact", "abcd"])("abcd dact"), "[redacted] [redacted]")

    def test_too_short_values_are_left_and_flagged(self):
        self.assertEqual(Redactor(["abc"])("abc"), "abc")
        config = Config.from_env(dict(ENV, MARIADB_ROOT_PASSWORD="abc"))
        self.assertEqual(config.short_secrets(), ["MARIADB_ROOT_PASSWORD"])
        self.assertEqual(Config.from_env(ENV).short_secrets(), [])

    def test_empty_output_keeps_header(self):
        self.assertEqual(error_message(Redactor(), "new-site failed (exit 1)", "  "), "new-site failed (exit 1)")


class ConfigTest(unittest.TestCase):
    def test_from_env(self):
        config = Config.from_env(ENV)
        self.assertEqual(config.agent_api_base, "https://api.studafy.com/api/internal/erpnext")
        self.assertEqual(config.python_bin, "/home/frappe/frappe-bench/env/bin/python")
        self.assertEqual(config.sites_dir, "/home/frappe/frappe-bench/sites")
        self.assertFalse(config.backups_enabled)
        self.assertIn("apisecretXYZ987", config.secret_values())

    def test_missing_variables_are_named_not_shown(self):
        env = dict(ENV)
        del env["ERPNEXT_AGENT_TOKEN"]
        with self.assertRaises(ConfigError) as caught:
            Config.from_env(env)
        self.assertIn("ERPNEXT_AGENT_TOKEN", str(caught.exception))
        self.assertNotIn(SECRETS["mariadb_root_password"], str(caught.exception))

    def test_bucket_needs_credentials(self):
        with self.assertRaises(ConfigError):
            Config.from_env(dict(ENV, BACKUP_S3_BUCKET="b"))
        full = dict(ENV, BACKUP_S3_BUCKET="b", BACKUP_S3_ENDPOINT="https://e", BACKUP_S3_ACCESS_KEY_ID="k",
                    BACKUP_S3_SECRET_ACCESS_KEY="s")
        self.assertTrue(Config.from_env(full).backups_enabled)


if __name__ == "__main__":
    unittest.main()
