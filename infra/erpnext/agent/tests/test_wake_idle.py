import tempfile
import unittest

import _support  # noqa: F401  (loads erpnext_agent)
from _support import CapturingLogger, FakeApi, FakeRunner, InstantStop, failed, make_config

from erpnext_agent.api import AgentApi
from erpnext_agent.sites import SiteJobs

ALPHA = {"id": "cfg-1", "site_name": "alpha.erpnext.studafy.com"}
BETA = {"id": "cfg-2", "site_name": "beta.erpnext.studafy.com"}


class WakeIdleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = FakeApi()
        self.config = make_config(self.tmp.name, api_url=self.server.url)
        self.log = CapturingLogger(self.config)
        self.stop = InstantStop()
        self.runner = FakeRunner()
        api = AgentApi(self.config.agent_api_base, self.config.agent_token, stop=self.stop)
        self.jobs = SiteJobs(self.config, api, self.runner, self.log, self.stop)

    def tearDown(self):
        self.server.close()
        self.tmp.cleanup()

    def test_wake_enables_scheduler_and_reports_woken(self):
        self.server.respond("GET", "/sites/wake", (200, {"sites": [ALPHA, BETA]}))

        self.jobs.run_wake()

        self.assertEqual(
            [call.argv for call in self.runner.calls],
            [
                ["bench", "--site", "alpha.erpnext.studafy.com", "enable-scheduler"],
                ["bench", "--site", "beta.erpnext.studafy.com", "enable-scheduler"],
            ],
        )
        self.assertTrue(all(call.cwd == self.config.bench_dir for call in self.runner.calls))
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-1/woken")), 1)
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-2/woken")), 1)
        self.assertEqual([r["outcome"] for r in self.log.events("site_woken")], ["ok", "ok"])

    def test_wake_failure_is_not_reported_and_other_sites_continue(self):
        self.server.respond("GET", "/sites/wake", (200, {"sites": [ALPHA, BETA]}))
        self.runner.on("alpha.erpnext.studafy.com", result=failed(1, stderr="Site not found"))

        self.jobs.run_wake()

        self.assertEqual(self.server.calls("POST", "/sites/cfg-1/woken"), [])
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-2/woken")), 1)
        alpha = self.log.events("site_woken")[0]
        self.assertEqual(alpha["outcome"], "failed")
        self.assertIn("Site not found", alpha["error"])

    def test_idle_disables_scheduler_and_reports_slept(self):
        self.server.respond("GET", "/sites/idle", (200, {"sites": [ALPHA]}))

        self.jobs.run_idle()

        self.assertEqual(
            [call.argv for call in self.runner.calls],
            [["bench", "--site", "alpha.erpnext.studafy.com", "disable-scheduler"]],
        )
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-1/slept")), 1)

    def test_nothing_to_do_makes_no_commands(self):
        self.jobs.run_wake()
        self.jobs.run_idle()
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(self.server.calls("POST"), [])

    def test_bad_site_name_from_api_is_skipped(self):
        self.server.respond("GET", "/sites/wake", (200, {"sites": [{"id": "x", "site_name": "a/../b"}]}))
        self.jobs.run_wake()
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(self.server.calls("POST"), [])


if __name__ == "__main__":
    unittest.main()
