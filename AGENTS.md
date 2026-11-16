# Working rules for AI assistants (Caroline Practice)

Read `APP_PLAN.md` sections 0–4 before changing anything. Short version:

- This is a side project of TSP Work: only the Practice page and the admin Ableton Sync page. Do not add Song IDs, tasks, setlists or gigs unless Aaron asks.
- Commit and publish straight away so Aaron can test: `node --check` the JS, bump the `?v=` markers, `git push origin main && git push origin main:gh-pages`.
- Keep the Mac folder `/Users/aaron/Claude Folders/Caroline Practice` identical to GitHub (it is a clone; `private/` is git-ignored and holds sign-ins).
- Never commit passwords or keys. RLS (`cp_is_member` / `cp_is_admin`) is the security boundary; never loosen TSP Work's policies for this app.
- Never modify the `.als`; warn Aaron about problems seen in it.
- When Aaron says **"Update App Plan"**, follow `APP_PLAN.md` section 0.
- Explain things plainly; Aaron is not a programmer.
