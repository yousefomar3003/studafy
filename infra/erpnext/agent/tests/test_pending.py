import os
import tempfile
import unittest

import _support
from _support import SECRETS, CapturingLogger, FakeApi, FakeRunner, InstantStop, failed, make_config

from erpnext_agent.api import AgentApi
from erpnext_agent.runner import Result
from erpnext_agent.sites import CREATING_MARKER, SiteJobs

SITE = {
    "id": "cfg-1",
    "school_id": "school-uuid-1",
    "site_name": "alpha.erpnext.studafy.com",
    "company_name": "Alpha School",
    "company_abbr": "ALPH",
    "currency_code": "JOD",
    "country_code": "JO",
}


class PendingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = FakeApi()
        self.config = make_config(self.tmp.name, api_url=self.server.url)
        self.log = CapturingLogger(self.config)
        self.stop = InstantStop()
        self.runner = FakeRunner()
        self.api = AgentApi(self.config.agent_api_base, self.config.agent_token, stop=self.stop)
        self.jobs = SiteJobs(self.config, self.api, self.runner, self.log, self.stop)
        self.server.respond("GET", "/sites/pending", (200, {"sites": [SITE]}))

    def tearDown(self):
        self.server.close()
        self.tmp.cleanup()

    def site_dir(self, name=SITE["site_name"]):
        return os.path.join(self.config.sites_dir, name)

    def make_site_dir(self, call=None):
        os.makedirs(self.site_dir(), exist_ok=True)

    def test_pending_site_is_created_provisioned_put_to_sleep_and_reported(self):
        self.runner.on("new-site", effect=self.make_site_dir)

        self.jobs.run_pending()

        self.assertEqual(self.runner.steps(), ["new-site", "provision", "disable-scheduler"])
        new_site, provision, disable = self.runner.calls
        self.assertEqual(
            new_site.argv,
            [
                "bench", "new-site", SITE["site_name"],
                "--mariadb-user-host-login-scope=localhost",
                f"--db-root-password={SECRETS['mariadb_root_password']}",
                f"--admin-password={SECRETS['admin_password']}",
                "--install-app", "erpnext", "--install-app", "education",
            ],
        )
        self.assertEqual(new_site.cwd, self.config.bench_dir)
        self.assertGreaterEqual(new_site.timeout, 15 * 60)
        self.assertTrue(new_site.interruptible)

        self.assertEqual(
            provision.argv,
            [
                os.path.join(self.tmp.name, "env", "bin", "python"), "-m", "erpnext_seed.provision",
                SITE["site_name"], "setup",
                "--company=Alpha School", "--abbr=ALPH", "--currency=JOD", "--country-code=JO",
                "--school-id=school-uuid-1", f"--api-url={self.server.url}",
            ],
        )
        self.assertEqual(provision.cwd, self.config.sites_dir)
        self.assertEqual(provision.env["STUDAFY_ERPNEXT_API_KEY"], SECRETS["erpnext_api_key"])
        self.assertEqual(provision.env["STUDAFY_ERPNEXT_WEBHOOK_SECRET"], SECRETS["webhook_secret"])
        self.assertNotIn("ERPNEXT_AGENT_TOKEN", provision.env)

        self.assertEqual(disable.argv, ["bench", "--site", SITE["site_name"], "disable-scheduler"])

        created = self.server.calls("POST", "/sites/cfg-1/created")
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["auth"], f"Bearer {SECRETS['agent_token']}")
        self.assertEqual(self.server.calls("POST", "/sites/cfg-1/failed"), [])
        self.assertFalse(os.path.exists(os.path.join(self.config.sites_dir, CREATING_MARKER.format(site=SITE["site_name"]))))
        self.assertEqual(self.log.events("site_created")[0]["outcome"], "ok")

    def test_failure_reports_scrubbed_stderr_tail_and_moves_on(self):
        second = dict(SITE, id="cfg-2", site_name="beta.erpnext.studafy.com", school_id="school-2")
        self.server.respond("GET", "/sites/pending", (200, {"sites": [SITE, second]}))
        noisy = "x" * 5000 + "\n" + "\n".join(
            f"Traceback: bad value {value} in config" for value in SECRETS.values()
        ) + "\napisecretXYZ987 alone\nfinal line"
        self.runner.on("erpnext_seed.provision", "alpha.erpnext.studafy.com", result=failed(1, stderr=noisy))

        self.jobs.run_pending()

        failed_reports = self.server.calls("POST", "/sites/cfg-1/failed")
        self.assertEqual(len(failed_reports), 1)
        error = failed_reports[0]["body"]["error"]
        self.assertTrue(error.startswith("provision failed (exit 1): "))
        self.assertLessEqual(len(error), 2000)
        self.assertTrue(error.endswith("final line"))
        for value in list(SECRETS.values()) + ["apikeyID1234", "apisecretXYZ987"]:
            self.assertNotIn(value, error)
        self.assertIn("[redacted]", error)
        # The failed site never reached disable-scheduler; the next site was still created.
        self.assertEqual(self.server.calls("POST", "/sites/cfg-1/created"), [])
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-2/created")), 1)
        # Nothing secret in the logs either.
        log_text = self.log.buffer.getvalue()
        for value in SECRETS.values():
            self.assertNotIn(value, log_text)

    def test_timeout_is_reported_as_failure(self):
        self.runner.on("new-site", result=Result(None, "", "", 900.0, timed_out=True))
        self.jobs.run_pending()
        error = self.server.calls("POST", "/sites/cfg-1/failed")[0]["body"]["error"]
        self.assertEqual(error, "new-site timed out after 900s")

    def test_existing_site_directory_skips_new_site(self):
        self.make_site_dir()

        self.jobs.run_pending()

        self.assertEqual(self.runner.steps(), ["provision", "disable-scheduler"])
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-1/created")), 1)

    def test_half_made_site_is_dropped_and_created_again(self):
        self.make_site_dir()
        marker = os.path.join(self.config.sites_dir, CREATING_MARKER.format(site=SITE["site_name"]))
        open(marker, "w").close()

        def drop(call):
            os.rmdir(self.site_dir())

        self.runner.on("drop-site", effect=drop).on("new-site", effect=self.make_site_dir)

        self.jobs.run_pending()

        self.assertEqual(self.runner.steps(), ["drop-site", "new-site", "provision", "disable-scheduler"])
        drop_call = self.runner.calls[0]
        self.assertIn(f"--db-root-password={SECRETS['mariadb_root_password']}", drop_call.argv)
        self.assertIn("--no-backup", drop_call.argv)
        self.assertFalse(os.path.exists(marker))
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-1/created")), 1)

    def test_failed_new_site_leaves_marker_for_cleanup(self):
        self.runner.on("new-site", effect=self.make_site_dir, result=failed(1, stdout="MariaDB error"))
        self.jobs.run_pending()
        marker = os.path.join(self.config.sites_dir, CREATING_MARKER.format(site=SITE["site_name"]))
        self.assertTrue(os.path.exists(marker))
        self.assertEqual(
            self.server.calls("POST", "/sites/cfg-1/failed")[0]["body"]["error"],
            "new-site failed (exit 1): MariaDB error",
        )

    def test_invalid_site_name_is_reported_without_running_anything(self):
        bad = dict(SITE, site_name="../../etc")
        self.server.respond("GET", "/sites/pending", (200, {"sites": [bad]}))
        self.jobs.run_pending()
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(self.server.calls("POST", "/sites/cfg-1/failed")[0]["body"]["error"], "invalid site_name")

    def test_shutdown_interrupts_without_reporting(self):
        self.runner.on("new-site", result=Result(None, "", "", 3.0, interrupted=True))
        self.jobs.run_pending()
        self.assertEqual(self.server.calls("POST"), [])
        self.assertEqual(self.log.events("site_interrupted")[0]["outcome"], "interrupted")

    def test_stop_between_sites(self):
        second = dict(SITE, id="cfg-2", site_name="beta.erpnext.studafy.com")
        self.server.respond("GET", "/sites/pending", (200, {"sites": [SITE, second]}))
        self.runner.on("disable-scheduler", effect=lambda call: self.stop.set("SIGTERM"))
        self.jobs.run_pending()
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-1/created")), 1)
        self.assertEqual(self.server.calls("POST", "/sites/cfg-2/created"), [])

    def test_lost_created_report_is_logged_not_raised(self):
        self.server.respond("POST", "/sites/cfg-1/created", (500, {"title": "boom"}))
        self.jobs.run_pending()  # must not raise
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-1/created")), 3)  # 3 attempts
        self.assertEqual(self.log.events("report_failed")[0]["status"], 500)


if __name__ == "__main__":
    unittest.main()
