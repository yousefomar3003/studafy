-- Scholarships can be deleted while nobody has been awarded them.
--
-- 000149 granted the app login SELECT, INSERT and UPDATE on app.scholarships but not DELETE: a
-- scholarship could only be deactivated. DELETE /api/finance/scholarships/{id} now removes one that
-- was never awarded (the service checks app.scholarship_awards first, and the RESTRICT foreign key
-- from scholarship_awards backs that up), so the app login needs DELETE on the catalog table.
-- app.scholarship_awards keeps no DELETE: an award is revoked, never removed.

SET ROLE studafy_admin;

GRANT DELETE ON TABLE app.scholarships TO studafy_app;

RESET ROLE;
