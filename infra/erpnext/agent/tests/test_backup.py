import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

import _support  # noqa: F401  (loads erpnext_agent)
from _support import SECRETS, CapturingLogger, FakeRunner, InstantStop, failed, make_config, ok

from erpnext_agent.backup import AMMAN, REMOTE, Backup, expired_date_dirs, next_backup_at

UTC = timezone.utc
BACKUP_KEYS = {
    "backup_bucket": "studafy-prod-erpnext-backups",
    "backup_endpoint": "https://acct.r2.cloudflarestorage.com",
    "backup_access_key_id": "r2-key-id-ABC123",
    "backup_secret_access_key": "r2-secret-DEF456",
}


class ScheduleTest(unittest.TestCase):
    def test_before_two_am_amman_runs_tonight(self):
        # 22:00 UTC is 01:00 in Amman (UTC+3): the backup is an hour away.
        self.assertEqual(next_backup_at(datetime(2026, 11, 27, 22, 0, tzinfo=UTC)),
                         datetime(2026, 11, 27, 23, 0, tzinfo=UTC))

    def test_after_two_am_amman_runs_tomorrow(self):
        # 09:00 UTC is 12:00 in Amman: next is 02:00 Amman on the 28th = 23:00 UTC on the 27th.
        self.assertEqual(next_backup_at(datetime(2026, 11, 27, 9, 0, tzinfo=UTC)),
                         datetime(2026, 11, 27, 23, 0, tzinfo=UTC))

    def test_exactly_two_am_schedules_the_next_night(self):
        two_am = datetime(2026, 11, 27, 23, 0, tzinfo=UTC)
        self.assertEqual(next_backup_at(two_am), two_am + timedelta(days=1))

    def test_result_is_two_am_local(self):
        for hour in range(24):
            at = next_backup_at(datetime(2026, 6, 1, hour, 30, tzinfo=UTC)).astimezone(AMMAN)
            self.assertEqual((at.hour, at.minute), (2, 0))

    def test_expired_date_dirs_keep_14_days_and_ignore_other_names(self):
        names = ["2026-11-27/", "2026-11-13/", "2026-11-12/", "2026-10-01/", "manual/", "2026-02-30/", ""]
        self.assertEqual(expired_date_dirs(names, date(2026, 11, 27)), ["2026-11-12", "2026-10-01"])


class BackupRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.stop = InstantStop()
        self.runner = FakeRunner()
        # 23:30 UTC on the 26th is 02:30 on the 27th in Amman.
        self.now = datetime(2026, 11, 26, 23, 30, tzinfo=UTC)

    def tearDown(self):
        self.tmp.cleanup()

    def backup(self, **overrides):
        self.config = make_config(self.tmp.name, **overrides)
        self.log = CapturingLogger(self.config)
        return Backup(self.config, self.runner, self.log, self.stop, clock=lambda: self.now)

    def make_site(self, name, files=()):
        folder = os.path.join(self.config.sites_dir, name, "private", "backups")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(self.config.sites_dir, name, "site_config.json"), "w") as handle:
            handle.write("{}")
        for file_name in files:
            open(os.path.join(folder, file_name), "w").close()
        return folder

    def test_skipped_with_warning_when_bucket_unset(self):
        backup = self.backup()
        backup.run()
        self.assertEqual(self.runner.calls, [])
        skipped = self.log.events("backup_skipped")
        self.assertEqual(len(skipped), 1)
        self.assertEqual(skipped[0]["level"], "warning")

    def test_backup_upload_delete_and_prune(self):
        backup = self.backup(**BACKUP_KEYS)
        self.make_site("alpha.erpnext.studafy.com")
        self.make_site("beta.erpnext.studafy.com")
        os.makedirs(os.path.join(self.config.sites_dir, "assets"))  # not a site

        def bench_backup(call):
            for site in ("alpha.erpnext.studafy.com", "beta.erpnext.studafy.com"):
                folder = os.path.join(self.config.sites_dir, site, "private", "backups")
                open(os.path.join(folder, f"20261127_023000-{site}-database.sql.gz"), "w").close()

        self.runner.on("backup", "--compress", effect=bench_backup)
        self.runner.on("lsf", result=ok(stdout="2026-11-27/\n2026-11-12/\n2026-11-13/\nnotes/\n"))

        backup.run()

        self.assertEqual(
            self.runner.steps(),
            ["backup --compress", "rclone copy", "rclone copy", "rclone lsf", "rclone purge"],
        )
        bench = self.runner.calls[0]
        self.assertEqual(bench.argv, ["bench", "--site", "all", "backup", "--compress"])
        self.assertEqual(bench.cwd, self.config.bench_dir)

        alpha_copy = self.runner.calls[1]
        self.assertEqual(alpha_copy.argv[2], os.path.join(self.config.sites_dir, "alpha.erpnext.studafy.com",
                                                          "private", "backups"))
        self.assertEqual(alpha_copy.argv[3],
                         f"{REMOTE}:studafy-prod-erpnext-backups/2026-11-27/alpha.erpnext.studafy.com/")
        prefix = f"RCLONE_CONFIG_{REMOTE.upper()}_"
        self.assertEqual(alpha_copy.env[prefix + "TYPE"], "s3")
        self.assertEqual(alpha_copy.env[prefix + "PROVIDER"], "Cloudflare")
        self.assertEqual(alpha_copy.env[prefix + "ENDPOINT"], BACKUP_KEYS["backup_endpoint"])
        self.assertEqual(alpha_copy.env[prefix + "ACCESS_KEY_ID"], BACKUP_KEYS["backup_access_key_id"])
        self.assertEqual(alpha_copy.env[prefix + "SECRET_ACCESS_KEY"], BACKUP_KEYS["backup_secret_access_key"])
        self.assertNotIn("ERPNEXT_AGENT_TOKEN", alpha_copy.env)

        self.assertEqual(self.runner.calls[4].argv[1:], ["purge", f"{REMOTE}:studafy-prod-erpnext-backups/2026-11-12"])

        for site in ("alpha.erpnext.studafy.com", "beta.erpnext.studafy.com"):
            self.assertEqual(os.listdir(os.path.join(self.config.sites_dir, site, "private", "backups")), [])
        finished = self.log.events("backup_finished")[0]
        self.assertEqual((finished["outcome"], finished["sites"], finished["failures"]), ("ok", 2, 0))
        log_text = self.log.buffer.getvalue()
        for value in list(SECRETS.values()) + [BACKUP_KEYS["backup_secret_access_key"]]:
            self.assertNotIn(value, log_text)

    def test_failed_upload_keeps_local_files(self):
        backup = self.backup(**BACKUP_KEYS)
        folder = self.make_site("alpha.erpnext.studafy.com", files=["a-database.sql.gz"])
        self.runner.on("copy", result=failed(1, stderr=f"403 Forbidden for {BACKUP_KEYS['backup_secret_access_key']}"))

        backup.run()

        self.assertEqual(os.listdir(folder), ["a-database.sql.gz"])
        upload = self.log.events("backup_upload")[0]
        self.assertEqual(upload["outcome"], "failed")
        self.assertNotIn(BACKUP_KEYS["backup_secret_access_key"], upload["error"])
        self.assertEqual(self.log.events("backup_finished")[0]["outcome"], "failed")

    def test_next_run_is_the_next_two_am(self):
        backup = self.backup()
        now = datetime(2026, 11, 27, 12, 0, tzinfo=UTC).timestamp()
        self.assertEqual(backup.next_run(now), datetime(2026, 11, 27, 23, 0, tzinfo=UTC).timestamp())


if __name__ == "__main__":
    unittest.main()
