import socket
import tempfile
import unittest

import _support  # noqa: F401  (loads erpnext_agent)
from _support import CapturingLogger, FakeApi, FakeRunner, InstantStop, make_config

from erpnext_agent.api import AgentApi, ApiError
from erpnext_agent.app import build
from erpnext_agent.scheduler import BACKOFF_CAP, SLOW_RETRY, Job, Scheduler, backoff_delay, every


class FakeClock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class BackoffTest(unittest.TestCase):
    def test_exponential_and_capped_at_five_minutes(self):
        self.assertEqual([backoff_delay(n) for n in range(1, 9)], [15, 30, 60, 120, 240, 300, 300, 300])
        self.assertEqual(backoff_delay(10_000), BACKOFF_CAP)


class ApiSchedulerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = FakeApi()
        self.config = make_config(self.tmp.name, api_url=self.server.url)
        self.log = CapturingLogger(self.config)
        self.stop = InstantStop()
        self.clock = FakeClock()
        self.api = AgentApi(self.config.agent_api_base, self.config.agent_token, stop=self.stop)
        self.scheduler = build(self.config, self.log, self.stop, runner=FakeRunner(), api=self.api, clock=self.clock)
        self.pending = next(job for job in self.scheduler.jobs if job.name == "pending")

    def tearDown(self):
        self.server.close()
        self.tmp.cleanup()

    def test_5xx_backs_off_exponentially_then_recovers(self):
        self.server.respond("GET", "/sites/pending", (503, {}), (502, {}), (500, {}), (200, {"sites": []}))

        delays = []
        for _ in range(3):
            self.scheduler.run_job(self.pending)
            delays.append(self.pending.next_run - self.clock.now)
        self.assertEqual(delays, [15, 30, 60])
        self.assertEqual(self.pending.failures, 3)
        self.assertEqual([r["status"] for r in self.log.events("api_unavailable")], [503, 502, 500])

        self.scheduler.run_job(self.pending)
        self.assertEqual(self.pending.failures, 0)
        self.assertEqual(self.pending.next_run - self.clock.now, 60)  # back to every minute

    def test_401_is_logged_loudly_and_retried_slowly(self):
        bad = AgentApi(self.config.agent_api_base, "wrong-token", stop=self.stop)
        scheduler = build(self.config, self.log, self.stop, runner=FakeRunner(), api=bad, clock=self.clock)
        job = scheduler.jobs[0]
        scheduler.run_job(job)  # must not raise
        self.assertEqual(job.next_run - self.clock.now, SLOW_RETRY)
        event = self.log.events("api_unauthorized")[0]
        self.assertEqual(event["level"], "error")
        self.assertNotIn("wrong-token", self.log.buffer.getvalue())

    def test_404_means_routes_not_mounted_and_is_retried_slowly(self):
        self.server.respond("GET", "/sites/pending", (404, {}))
        self.scheduler.run_job(self.pending)
        self.assertEqual(self.pending.next_run - self.clock.now, SLOW_RETRY)
        self.assertEqual(len(self.log.events("api_not_found")), 1)

    def test_network_error_is_transient(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        dead = AgentApi(f"http://127.0.0.1:{port}/api/internal/erpnext", "t", stop=self.stop, timeout=2)
        with self.assertRaises(ApiError) as caught:
            dead.pending_sites()
        self.assertTrue(caught.exception.transient)
        self.assertIsNone(caught.exception.status)

    def test_report_retries_5xx_in_place(self):
        self.server.respond("POST", "/sites/cfg-1/woken", (500, {}), (204, None))
        self.api.report_woken("cfg-1")
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-1/woken")), 2)
        self.assertEqual(self.stop.waits, [2.0])

    def test_report_does_not_retry_4xx(self):
        self.server.respond("POST", "/sites/cfg-9/woken", (404, {}))
        with self.assertRaises(ApiError) as caught:
            self.api.report_woken("cfg-9")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(len(self.server.calls("POST", "/sites/cfg-9/woken")), 1)

    def test_unexpected_shape_is_an_error(self):
        self.server.respond("GET", "/sites/pending", (200, {"sites": "nope"}))
        with self.assertRaises(ApiError):
            self.api.pending_sites()

    def test_redirects_are_not_followed(self):
        self.server.respond("GET", "/sites/pending", (302, {}))
        with self.assertRaises(ApiError) as caught:
            self.api.pending_sites()
        self.assertEqual(caught.exception.status, 302)
        self.assertEqual(len(self.server.calls("GET")), 1)

    def test_unexpected_exception_never_escapes(self):
        def boom():
            raise RuntimeError("bug")

        job = Job("x", boom, every(60), next_run=self.clock.now)
        Scheduler([job], self.log, self.stop, clock=self.clock).run_job(job)
        self.assertEqual(job.next_run - self.clock.now, 15)
        self.assertEqual(self.log.events("job_error")[0]["error"], "RuntimeError: bug")

    def test_backup_job_is_scheduled_for_two_am_and_does_not_retry_errors(self):
        backup = next(job for job in self.scheduler.jobs if job.name == "backup")
        self.assertFalse(backup.retry_errors)
        self.assertGreater(backup.next_run, self.clock.now)
        self.assertLessEqual(backup.next_run - self.clock.now, 24 * 3600)

    def test_run_forever_runs_due_jobs_in_order_and_stops(self):
        order = []
        clock = self.clock

        def make(name):
            def run():
                order.append(name)
                if len(order) == 3:
                    self.stop.set("SIGTERM")
            return run

        jobs = [
            Job("later", make("later"), every(60), next_run=clock.now + 10),
            Job("first", make("first"), every(60), next_run=clock.now - 5),
            Job("second", make("second"), every(60), next_run=clock.now),
        ]
        scheduler = Scheduler(jobs, self.log, self.stop, clock=clock)

        original_wait = self.stop.wait

        def wait(seconds):
            clock.now += seconds  # time passes while the loop sleeps
            return original_wait(seconds)

        self.stop.wait = wait
        scheduler.run_forever()
        self.assertEqual(order, ["first", "second", "later"])


if __name__ == "__main__":
    unittest.main()
