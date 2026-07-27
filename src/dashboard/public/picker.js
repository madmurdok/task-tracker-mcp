async function loadProjects() {
  const list = document.getElementById("project-list");
  const emptyState = document.getElementById("empty-state");

  const res = await fetch("/api/projects");
  const { projects } = await res.json();

  if (projects.length === 0) {
    emptyState.hidden = false;
    return;
  }

  for (const project of projects) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = `board.html?project=${encodeURIComponent(project.id)}`;
    link.textContent = project.name;
    li.appendChild(link);
    list.appendChild(li);
  }
}

function wireShutdownButton() {
  const button = document.getElementById("shutdown-button");
  button.addEventListener("click", async () => {
    if (!window.confirm("Stop the dashboard server?")) return;
    button.disabled = true;
    button.textContent = "Stopping...";
    try {
      await fetch("/api/shutdown", { method: "POST" });
    } catch {
      // Expected once the process actually exits mid-response - the
      // button's final state below covers this either way.
    }
    button.textContent = "Dashboard stopped";
  });
}

loadProjects();
wireShutdownButton();
