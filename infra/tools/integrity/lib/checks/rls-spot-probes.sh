#!/usr/bin/env bash
# The behavioural RLS spot probes for infra/tools/integrity, plus the catalogue sub-probe
# (04-rls-catalog.sql). Sourced by run-integrity-check.sh; exposes run_rls_spot_probes, which prints
# exactly one JSON line -- the same shape every other check emits -- describing the aggregated
# rls-spot-probes result over four sub-probes:
#
#   i.   fail-closed: a read as studafy_app with NO app.school_id GUC must raise
#        "unrecognized configuration parameter app.school_id" (SQLSTATE 42704). Returning rows
#        instead means RLS is not actually filtering tenant reads.
#   ii.  wrong-GUC: with a nonexistent school UUID as app.school_id, studafy_app must see zero rows
#        on every probe table.
#   iii. correct-GUC parity: with the real school_id AND a real ORG_ADMIN/SUPER_ADMIN app.user_id,
#        studafy_app's count per probe table must equal the superuser-role count (explicit WHERE
#        school_id), i.e. a legitimate admin sees exactly this tenant and nothing else.
#   iv.  catalogue: 04-rls-catalog.sql -- relrowsecurity/relforcerowsecurity/policy shape on six
#        tables (immutable catalog facts, no GUC needed).
#
# Probe tables for i-iii are students, enrollments, invoice_cache, grades -- each isolated by
# tenant_isolation only (no role_scope_visibility second policy to reason around).

run_rls_spot_probes() {
  local school_id="$1" admin_user_id="$2" checks_dir="$3"
  local wrong_uuid="00000000-0000-0000-0000-000000000000"
  local -a probe_tables=(students enrollments invoice_cache grades)
  local -a findings=()
  local -a summary=()
  local overall="pass"

  local rc out baseline_count count mismatch_count table cat_json cat_status

  # --- i. fail-closed no-GUC read -------------------------------------------
  rc=0; out=""
  out="$(psql -tA -v ON_ERROR_STOP=1 -c "SET ROLE studafy_app; SELECT count(*) FROM app.students" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    if [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "0" ]; then
      findings+=("$(jq -n --arg t 'no-GUC-read' '{table: $t, issue: "rls-fail-open", detail: "app.students read as studafy_app with no app.school_id GUC returned 0 rows instead of raising -- tenant isolation is not enforcing an explicit tenant scope"}' )")
      overall="fail"
      summary+=("no-GUC fail-closed read: FAIL (returned 0 rows, did not raise)")
    else
      findings+=("$(jq -n --arg t 'no-GUC-read' '{table: $t, issue: "rls-fail-open", detail: "app.students read as studafy_app with no app.school_id GUC returned rows instead of raising -- RLS is not filtering tenant reads"}' )")
      overall="fail"
      summary+=("no-GUC fail-closed read: FAIL (returned rows, did not raise)")
    fi
  elif printf '%s' "$out" | grep -q 'app.school_id'; then
    summary+=("no-GUC fail-closed read: PASS (raised unrecognized configuration parameter app.school_id)")
  else
    findings+=("$(jq -n --arg d "unexpected failure on no-GUC read: $out" '{table: "no-GUC-read", issue: "probe-error", detail: $d}')")
    overall="error"
    summary+=("no-GUC fail-closed read: ERROR (unexpected psql failure)")
  fi

  # --- ii. wrong-GUC zero rows ----------------------------------------------
  mismatch_count=0
  for t in "${probe_tables[@]}"; do
    rc=0; count=""
    count="$(psql -tA -v ON_ERROR_STOP=1 \
      -c "SELECT set_config('app.school_id', '$wrong_uuid', false)" \
      -c "SELECT set_config('app.user_id', '$admin_user_id', false)" \
      -c "SET ROLE studafy_app; SELECT count(*) FROM app.\"$t\"" \
      | tail -n1)" || rc=$?
    if [ "$rc" -ne 0 ]; then
      findings+=("$(jq -n --arg t "$t" --arg d "wrong-GUC probe failed on $t: $count" '{table: $t, issue: "probe-error", detail: $d}')")
      overall="error"
      mismatch_count=$((mismatch_count + 1))
    elif [ "$(printf '%s' "$count" | tr -d '[:space:]')" != "0" ]; then
      findings+=("$(jq -n --arg t "$t" --arg c "$count" --arg w "$wrong_uuid" '{table: $t, issue: "wrong-tenant-not-empty", detail: ("app." + $t + " returned " + $c + " rows for nonexistent school " + $w + " -- RLS is not scoping reads to app.school_id")}')")
      overall="fail"
      mismatch_count=$((mismatch_count + 1))
    fi
  done
  if [ "$mismatch_count" -eq 0 ]; then
    summary+=("wrong-GUC zero-row read on ${#probe_tables[@]} table(s): PASS")
  else
    summary+=("wrong-GUC zero-row read: $mismatch_count failure(s)")
  fi

  # --- iii. correct-GUC parity vs superuser baseline -------------------------
  mismatch_count=0
  for t in "${probe_tables[@]}"; do
    rc=0; baseline_count=""
    baseline_count="$(psql -tA -v ON_ERROR_STOP=1 \
      -c "SELECT count(*) FROM app.\"$t\" WHERE school_id = '$school_id'" \
      )" || rc=$?
    if [ "$rc" -ne 0 ]; then
      findings+=("$(jq -n --arg t "$t" --arg d "baseline count failed on $t: $baseline_count" '{table: $t, issue: "probe-error", detail: $d}')")
      overall="error"
      mismatch_count=$((mismatch_count + 1))
      continue
    fi
    rc=0; count=""
    count="$(psql -tA -v ON_ERROR_STOP=1 \
      -c "SELECT set_config('app.school_id', '$school_id', false)" \
      -c "SELECT set_config('app.user_id', '$admin_user_id', false)" \
      -c "SET ROLE studafy_app; SELECT count(*) FROM app.\"$t\"" \
      | tail -n1)" || rc=$?
    if [ "$rc" -ne 0 ]; then
      findings+=("$(jq -n --arg t "$t" --arg d "studafy_app count failed on $t: $count" '{table: $t, issue: "probe-error", detail: $d}')")
      overall="error"
      mismatch_count=$((mismatch_count + 1))
    elif [ "$(printf '%s' "$count" | tr -d '[:space:]')" != "$(printf '%s' "$baseline_count" | tr -d '[:space:]')" ]; then
      findings+=("$(jq -n --arg t "$t" --arg b "$baseline_count" --arg c "$count" '{table: $t, issue: "admin-count-mismatch", detail: ("app." + $t + ": studafy_app sees " + $c + " rows under the correct GUC but the school actually has " + $b + " -- isolation is hiding or leaking tenant rows")}')")
      overall="fail"
      mismatch_count=$((mismatch_count + 1))
    fi
  done
  if [ "$mismatch_count" -eq 0 ]; then
    summary+=("correct-GUC admin parity on ${#probe_tables[@]} table(s): PASS")
  else
    summary+=("correct-GUC admin parity: $mismatch_count mismatch(es)")
  fi

  # --- iv. catalogue sub-probe ------------------------------------------------
  rc=0; cat_json=""
  cat_json="$(psql -tA -v ON_ERROR_STOP=1 -f "$checks_dir/04-rls-catalog.sql" 2>&1 | tail -n1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    findings+=("$(jq -n --arg d "catalogue probe failed: $cat_json" '{table: "catalog", issue: "probe-error", detail: $d}')")
    overall="error"
    summary+=("catalogue probe: ERROR")
  elif ! printf '%s' "$cat_json" | jq -e 'type == "object" and (.status | type) == "string"' >/dev/null 2>&1; then
    findings+=("$(jq -n --arg d "catalogue probe returned invalid JSON: $cat_json" '{table: "catalog", issue: "probe-error", detail: $d}')")
    overall="error"
    summary+=("catalogue probe: ERROR (invalid JSON)")
  else
    cat_status="$(printf '%s' "$cat_json" | jq -r '.status')"
    if [ "$cat_status" = "fail" ]; then
      while IFS= read -r f; do
        findings+=("$f")
      done < <(printf '%s' "$cat_json" | jq -c '.findings[]')
      overall="fail"
      summary+=("catalogue probe: FAIL ($(printf '%s' "$cat_json" | jq -r '.findings_count') defect(s))")
    elif [ "$cat_status" = "error" ]; then
      overall="error"
      summary+=("catalogue probe: ERROR")
    else
      summary+=("catalogue probe: PASS")
    fi
  fi

  local summary_text
  summary_text="$(printf '%s; ' "${summary[@]}" | sed 's/; $//')"

  jq -n \
    --arg check "rls-spot-probes" \
    --arg status "$overall" \
    --argjson findings "[$(IFS=,; echo "${findings[*]:-}")]" \
    --arg summary "$summary_text" \
    '{check: $check, status: $status,
      findings_count: ($findings | length),
      findings: ($findings | .[0:100]),
      summary: $summary}'
}