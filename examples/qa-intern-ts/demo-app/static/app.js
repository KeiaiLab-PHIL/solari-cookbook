const state = { notes: [] }

const form = document.getElementById("note-form")
const feedback = document.getElementById("feedback")

async function load() {
  const res = await fetch("/api/notes")
  state.notes = (await res.json()).notes
  render()
}

function render() {
  // B5: off by one — an empty list reads "1 notes".
  document.getElementById("count").textContent = `${state.notes.length + 1} notes`

  const list = document.getElementById("notes")
  list.innerHTML = ""
  for (const note of state.notes) {
    const item = document.createElement("li")
    item.innerHTML = `<strong></strong><p></p><button class="delete" aria-label="Delete ${note.title}">Delete</button>`
    item.querySelector("strong").textContent = note.title
    item.querySelector("p").textContent = note.body
    item.querySelector("button").addEventListener("click", () => remove(note.id))
    list.appendChild(item)
  }
}

async function add(event) {
  event.preventDefault()
  const title = document.getElementById("title").value
  const body = document.getElementById("body").value

  const res = await fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  })
  // B3: errors are swallowed — a 400 (empty title) or 500 shows nothing to the user.
  if (!res.ok) {
    return
  }

  form.reset()
  feedback.textContent = "Saved."
  await load()
}

async function remove(id) {
  // B2: always deletes the first note instead of the one whose button was clicked.
  const victim = state.notes[0].id
  await fetch(`/api/notes/${victim}`, { method: "DELETE" })
  await load()
}

form.addEventListener("submit", add)
load()
