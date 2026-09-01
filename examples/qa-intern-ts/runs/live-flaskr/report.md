# QA intern report — https://github.com/pallets/flask (examples/tutorial)

**Verdict: FAIL** — 1 issue(s) (1 major)

| | |
|---|---|
| Target | https://github.com/pallets/flask (examples/tutorial) (built and served in a Solari sandbox) |
| Browser session | `ip-10-0-10-199:87274c89-f5cb-42da-8441-c0968c99c772:cmtigtji301bqo101fik2drer:1788264866782.Br637OSuB6uUKLzKQGMZBg` |
| Replay | [replay.html](replay.html) — the events are saved next to this report |
| Sandbox | `ZGVza3RvcC1wb29sLWktMGZkOWVkN2RjMDNhNzlkYjI6dm1fMDAxMDkxOmNtdGlndGppMzAxYnFvMTAxZmlrMmRyZXI6MTc4ODI2NDg2MDgyMg.j2KMFIcLtHvMMrOmO4HihSaGOoAWcIhOPCdb5UjLye4` |
| Duration | 1m 22s |
| Actions | 30/30 across 35 model turns |
| Model | nvidia · openai/gpt-oss-120b |
| Tokens | in 202,581 · cache read 0 · cache write 0 · out 2,864 |

## Summary

Tested registration, login, post creation, editing, and attempted deletion. Delete operation fails to remove post after confirmation. No other major issues observed.

## Issues

### 1. [major] Delete post does not remove post after confirmation

*functional · confidence high · at https://78ded62487bde1a66b37-3000.preview.getsolari.com/auth/login*

Steps to reproduce:

1. Log in as testuser
2. Create a post
3. Click Edit on the post
4. Click Delete and accept confirmation dialog
5. Return to posts list

**Expected:** Post should be removed from the list

**Actual:** Post remains visible after deletion

![evidence](screenshots/issue-1.jpg)

Signals around this issue:

- dialog: confirm: Are you sure - accepted

## Machine-collected signals

| # | Kind | Page | Detail |
|---|---|---|---|
| 1 | dialog | https://78ded62487bde1a66b37-3000.preview.getsolari.com/1/update | confirm: Are you sure - accepted |

## Pages visited

- https://78ded62487bde1a66b37-3000.preview.getsolari.com/
- https://78ded62487bde1a66b37-3000.preview.getsolari.com/auth/register
- https://78ded62487bde1a66b37-3000.preview.getsolari.com/auth/login
- https://78ded62487bde1a66b37-3000.preview.getsolari.com/
- https://78ded62487bde1a66b37-3000.preview.getsolari.com/create
- https://78ded62487bde1a66b37-3000.preview.getsolari.com/1/update
