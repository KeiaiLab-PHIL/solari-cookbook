# Planted bugs — the answer key

Nebula Notes ships with six defects on purpose. Score a QA run by counting how
many of these the intern reported.

| ID | Symptom a user sees | How to reproduce | Detectable by | Severity |
|----|---------------------|------------------|---------------|----------|
| B1 | "Changelog" in the nav goes to a 404 | Click **Changelog** | `check_links`, `http.error 404` | minor |
| B2 | Deleting a note removes a *different* note | Add a note, click **Delete** on it — the first note disappears instead | judgment (compare list before/after) | major |
| B3 | Submitting with an empty title does nothing — no message | Leave Title empty, click **Add note** | `http.error 400` + no feedback in UI | major |
| B4 | A non-ASCII title (é, 한글, emoji) fails with a server error, silently | Title `héllo 🚀`, click **Add note** | `http.error 500`, `server_logs` shows `UnicodeEncodeError` | critical |
| B5 | Note count is off by one ("3 notes" for two notes) | Load the home page, count the list | judgment (count vs. list) | minor |
| B6 | Settings page throws on load; **Save** does nothing | Open **Settings**, pick a theme, click **Save** | `page.error TypeError`, no "Saved." | major |

Bugs B1, B3, B4 and B6 leave machine-readable evidence (a signal). B2 and B5
require the intern to compare what the UI shows against what it should show.
