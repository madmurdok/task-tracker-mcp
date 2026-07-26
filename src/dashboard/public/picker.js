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

loadProjects();
