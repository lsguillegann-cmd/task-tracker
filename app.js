import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  getDocs,
  writeBatch,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const tasksCollection = collection(db, 'tasks');
const tasksQuery = query(tasksCollection, orderBy('createdAt', 'desc'));

// Statuses that count toward the combined "To Do / Pending" summary tile.
const TODO_PENDING_STATUSES = ['To Do', 'Pending'];

// Only these Google accounts may enter the dashboard. This is a UI-level
// gate only — it does not replace Firestore Security Rules, which should
// also restrict access (see project notes).
const APPROVED_EMAILS = ['l.sguillegann@gmail.com', 'tjgdeleon@gmail.com'];

function isApproved(user) {
  const email = (user.email || '').toLowerCase();
  return APPROVED_EMAILS.includes(email);
}

let tasks = [];
let editingTaskId = null;
let detailsTaskId = null;
let currentUser = null;
let unsubscribeTasks = null;
let currentView = 'table'; // 'table' | 'report'

// "Editing as" is an app-level attribution tag only — it has no bearing on
// authentication or authorization. The signed-in Firebase user (currentUser)
// remains the sole security identity; this just labels who was picked as the
// acting editor at the time a task was written, for display purposes.
let editorName = 'Wheng';
try {
  const savedEditor = localStorage.getItem('wod.editorName');
  if (savedEditor === 'Wheng' || savedEditor === 'TJ') editorName = savedEditor;
} catch (e) { /* storage unavailable — default stands */ }

const el = {
  editorSelect: document.getElementById('editorSelect'),
  editorToggle: document.getElementById('editorToggle'),
  addTaskBtn: document.getElementById('addTaskBtn'),
  modal: document.getElementById('taskModal'),
  modalTitle: document.getElementById('modalTitle'),
  form: document.getElementById('taskForm'),
  cancelBtn: document.getElementById('cancelBtn'),
  tableBody: document.getElementById('taskTableBody'),
  emptyState: document.getElementById('emptyState'),
  filterStatus: document.getElementById('filterStatus'),
  filterProject: document.getElementById('filterProject'),
  filterPriority: document.getElementById('filterPriority'),
  filterWeek: document.getElementById('filterWeek'),
  clearFiltersBtn: document.getElementById('clearFiltersBtn'),
  countTotal: document.getElementById('countTotal'),
  countTodoPending: document.getElementById('countTodoPending'),
  countInProgress: document.getElementById('countInProgress'),
  countCompleted: document.getElementById('countCompleted'),
  authScreen: document.getElementById('authScreen'),
  accessDeniedScreen: document.getElementById('accessDeniedScreen'),
  accessDeniedMessage: document.getElementById('accessDeniedMessage'),
  accessDeniedSignOutBtn: document.getElementById('accessDeniedSignOutBtn'),
  loadingScreen: document.getElementById('loadingScreen'),
  appMain: document.getElementById('appMain'),
  signInBtn: document.getElementById('signInBtn'),
  signOutBtn: document.getElementById('signOutBtn'),
  userInfo: document.getElementById('userInfo'),
  userLabel: document.getElementById('userLabel'),
  errorBanner: document.getElementById('errorBanner'),
  tableView: document.getElementById('tableView'),
  reportView: document.getElementById('reportView'),
  viewTableBtn: document.getElementById('viewTableBtn'),
  viewReportBtn: document.getElementById('viewReportBtn'),
  reportSubtitle: document.getElementById('reportSubtitle'),
  reportBody: document.getElementById('reportBody'),
  reportEmptyState: document.getElementById('reportEmptyState'),
  copyReportBtn: document.getElementById('copyReportBtn'),
  printReportBtn: document.getElementById('printReportBtn'),
  detailsModal: document.getElementById('detailsModal'),
  detailsName: document.getElementById('detailsName'),
  detailsMeta: document.getElementById('detailsMeta'),
  detailsWorkDone: document.getElementById('detailsWorkDone'),
  detailsValidation: document.getElementById('detailsValidation'),
  detailsLinks: document.getElementById('detailsLinks'),
  detailsNotes: document.getElementById('detailsNotes'),
  detailsCloseX: document.getElementById('detailsCloseX'),
  detailsCloseBtn: document.getElementById('detailsCloseBtn'),
  detailsEditBtn: document.getElementById('detailsEditBtn'),
  detailsDeleteBtn: document.getElementById('detailsDeleteBtn'),
};

function showError(message) {
  el.errorBanner.textContent = message;
  el.errorBanner.hidden = false;
}

function clearError() {
  el.errorBanner.hidden = true;
  el.errorBanner.textContent = '';
}

function setLoading(message) {
  if (message) {
    el.loadingScreen.querySelector('p').textContent = message;
    el.loadingScreen.hidden = false;
  } else {
    el.loadingScreen.hidden = true;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function statusBadgeClass(status) {
  switch (status) {
    case 'To Do': return 'badge-status-todo';
    case 'In Progress': return 'badge-status-inprogress';
    case 'Completed': return 'badge-status-completed';
    case 'Pending': return 'badge-status-pending';
    default: return '';
  }
}

function priorityBadgeClass(priority) {
  switch (priority) {
    case 'Low': return 'badge-priority-low';
    case 'Medium': return 'badge-priority-medium';
    case 'High': return 'badge-priority-high';
    default: return '';
  }
}

function renderLinks(links) {
  if (!links) return '';
  return links
    .split(',')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      if (/^https?:\/\//i.test(l)) {
        return `<a href="${escapeHtml(l)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l)}</a>`;
      }
      return escapeHtml(l);
    })
    .join('<br>');
}

// Formats a Firestore Timestamp (or null, while a serverTimestamp() write is
// still pending locally) into a short, readable string.
function formatTimestamp(ts) {
  if (!ts || typeof ts.toDate !== 'function') return 'just now';
  return ts.toDate().toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function rowTitle(task) {
  const parts = [];
  if (task.updatedByName) {
    parts.push(`Last updated by ${task.updatedByName} (${formatTimestamp(task.updatedAt)})`);
  }
  if (task.createdByName) {
    parts.push(`Created by ${task.createdByName} (${formatTimestamp(task.createdAt)})`);
  }
  // editorTag is an optional, backward-compatible attribution field — older
  // tasks written before this field existed simply omit this line.
  if (task.editorTag) {
    parts.push(`Tagged as ${task.editorTag}`);
  }
  return parts.join('\n');
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function tsMillis(ts) {
  return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
}

// Orders week labels by the earliest createdAt among their tasks, so weeks
// read chronologically (as entered) rather than alphabetically.
function weekOrder() {
  const first = new Map();
  for (const t of tasks) {
    const key = t.weekDate || '';
    const ts = tsMillis(t.createdAt);
    if (!first.has(key) || ts < first.get(key)) first.set(key, ts);
  }
  return first;
}

function sortedWeeks() {
  const order = weekOrder();
  return uniqueSorted(tasks.map(t => t.weekDate)).sort((a, b) => (order.get(a) || 0) - (order.get(b) || 0));
}

function populateFilterOptions() {
  fillSelectPreservingValue(el.filterProject, uniqueSorted(tasks.map(t => t.project)));
  fillSelectPreservingValue(el.filterWeek, sortedWeeks());
}

function fillSelectPreservingValue(selectEl, values) {
  const currentValue = selectEl.value;
  selectEl.innerHTML = '<option value="">All</option>' +
    values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (values.includes(currentValue)) {
    selectEl.value = currentValue;
  }
}

function getActiveFilters() {
  return {
    week: el.filterWeek.value,
    project: el.filterProject.value,
    status: el.filterStatus.value,
    priority: el.filterPriority.value,
  };
}

function getFilteredTasks() {
  const { week, project, status, priority } = getActiveFilters();
  return tasks.filter(t => {
    if (week && t.weekDate !== week) return false;
    if (project && t.project !== project) return false;
    if (status && t.status !== status) return false;
    if (priority && t.priority !== priority) return false;
    return true;
  });
}

function updateSummary() {
  // Summary counts reflect ALL tasks, not just the current filter selection,
  // so the top tiles always describe the whole shared tracker.
  el.countTotal.textContent = tasks.length;
  el.countTodoPending.textContent = tasks.filter(t => TODO_PENDING_STATUSES.includes(t.status)).length;
  el.countInProgress.textContent = tasks.filter(t => t.status === 'In Progress').length;
  el.countCompleted.textContent = tasks.filter(t => t.status === 'Completed').length;
}

function renderTasks() {
  const filtered = getFilteredTasks();
  el.emptyState.hidden = filtered.length > 0;
  el.tableBody.innerHTML = filtered.map(t => `
    <tr data-id="${t.id}" title="${escapeHtml(rowTitle(t))}">
      <td><span class="task-name-link">${escapeHtml(t.name)}</span></td>
      <td>${escapeHtml(t.project)}</td>
      <td class="week">${escapeHtml(t.weekDate)}</td>
      <td><span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status)}</span></td>
      <td><span class="badge ${priorityBadgeClass(t.priority)}">${escapeHtml(t.priority)}</span></td>
      <td class="date">${escapeHtml(t.dueDate)}</td>
    </tr>
  `).join('');
}

// --- Weekly Report View -----------------------------------------------
// Groups the currently-filtered tasks by Week (chronological, by earliest
// createdAt), then by Project within each week — this is what makes the
// report read as a weekly update rather than a flat dump of every task.
// Same filtered task set as the table view (respects Week/Project/Status/
// Priority filters), just presented for reporting rather than editing.

function reportFilterSummaryText() {
  const { week, project, status, priority } = getActiveFilters();
  const parts = [];
  parts.push(week ? `Week: ${week}` : 'All Weeks');
  if (project) parts.push(`Project: ${project}`);
  if (status) parts.push(`Status: ${status}`);
  if (priority) parts.push(`Priority: ${priority}`);
  return parts.join(' · ');
}

function reportWeekGroups(filtered) {
  const order = weekOrder();
  const byWeek = new Map();
  for (const t of filtered) {
    const key = t.weekDate || 'Unspecified Week';
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(t);
  }
  const weeks = [...byWeek.entries()].sort(([a], [b]) => (order.get(a) || 0) - (order.get(b) || 0));
  return weeks.map(([week, items]) => {
    const byProject = new Map();
    for (const t of items) {
      const key = t.project || 'Unassigned';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(t);
    }
    const projects = [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    return [week, items, projects];
  });
}

function reportSummaryCounts(filtered) {
  return {
    total: filtered.length,
    todoPending: filtered.filter(t => TODO_PENDING_STATUSES.includes(t.status)).length,
    inProgress: filtered.filter(t => t.status === 'In Progress').length,
    completed: filtered.filter(t => t.status === 'Completed').length,
  };
}

function renderReportView() {
  const filtered = getFilteredTasks();
  el.reportSubtitle.textContent = reportFilterSummaryText();
  el.reportEmptyState.hidden = filtered.length > 0;
  if (!filtered.length) {
    el.reportBody.innerHTML = '';
    return;
  }

  const s = reportSummaryCounts(filtered);
  const summaryHtml = `
    <div class="report-summary">
      <span><strong>${s.total}</strong> Total</span>
      <span><strong>${s.todoPending}</strong> To Do / Pending</span>
      <span><strong>${s.inProgress}</strong> In Progress</span>
      <span><strong>${s.completed}</strong> Completed</span>
    </div>`;

  const weeksHtml = reportWeekGroups(filtered).map(([week, items, projects]) => {
    const wc = reportSummaryCounts(items);
    return `
    <div class="report-week">
      <h3 class="report-week-title">${escapeHtml(week)}</h3>
      <div class="report-week-summary">${wc.total} task${wc.total === 1 ? '' : 's'} · ${wc.completed} Completed · ${wc.inProgress} In Progress${wc.todoPending ? ` · ${wc.todoPending} To Do/Pending` : ''}</div>
      ${projects.map(([project, tasksInProject]) => `
        <div class="report-project-group">
          ${projects.length > 1 ? `<h4 class="report-project-title">${escapeHtml(project)}</h4>` : ''}
          ${tasksInProject.map(t => `
            <div class="report-item">
              <div class="report-item-head">
                <span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status)}</span>
                <strong>${escapeHtml(t.name)}</strong>
              </div>
              ${t.workDone ? `<p class="report-line"><b>Work Done:</b> ${escapeHtml(t.workDone)}</p>` : ''}
              ${t.validation ? `<p class="report-line"><b>Validation:</b> ${escapeHtml(t.validation)}</p>` : ''}
              ${t.notes ? `<p class="report-line"><b>Next Step:</b> ${escapeHtml(t.notes)}</p>` : ''}
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>`;
  }).join('');

  el.reportBody.innerHTML = summaryHtml + weeksHtml;
}

function buildReportText() {
  const filtered = getFilteredTasks();
  const s = reportSummaryCounts(filtered);
  const lines = [
    'WEEKLY OPS REPORT',
    reportFilterSummaryText(),
    `Generated: ${new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`,
    '',
    `Summary: ${s.total} Total | ${s.todoPending} To Do/Pending | ${s.inProgress} In Progress | ${s.completed} Completed`,
    '',
  ];

  for (const [week, items, projects] of reportWeekGroups(filtered)) {
    lines.push(`=== ${week} ===`);
    for (const [project, tasksInProject] of projects) {
      if (projects.length > 1) lines.push(`-- ${project} --`);
      for (const t of tasksInProject) {
        lines.push(`- [${t.status}] ${t.name}`);
        if (t.workDone) lines.push(`    Work Done: ${t.workDone}`);
        if (t.validation) lines.push(`    Validation: ${t.validation}`);
        if (t.notes) lines.push(`    Next Step: ${t.notes}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

async function handleCopyReport() {
  const text = buildReportText();
  try {
    await navigator.clipboard.writeText(text);
    const original = el.copyReportBtn.textContent;
    el.copyReportBtn.textContent = 'Copied!';
    setTimeout(() => { el.copyReportBtn.textContent = original; }, 1500);
  } catch (err) {
    console.error('Clipboard copy failed', err);
    showError('Could not copy to clipboard. Your browser may be blocking it.');
  }
}

function setView(view) {
  currentView = view;
  const isTable = view === 'table';
  el.tableView.hidden = !isTable;
  el.reportView.hidden = isTable;
  el.viewTableBtn.classList.toggle('active', isTable);
  el.viewReportBtn.classList.toggle('active', !isTable);
  el.viewTableBtn.setAttribute('aria-selected', String(isTable));
  el.viewReportBtn.setAttribute('aria-selected', String(!isTable));
  // Add Task only makes sense in the editable table view.
  el.addTaskBtn.hidden = !isTable || !currentUser;
  if (!isTable) renderReportView();
}

// Sets the app-level "Editing as" attribution tag. This has no effect on
// Firebase Authentication or the APPROVED_EMAILS gate — it purely labels
// which of the two known editors is acting, for display on tasks going
// forward. The authenticated Firebase user remains the security identity.
function setEditor(name) {
  editorName = name;
  try { localStorage.setItem('wod.editorName', name); } catch (e) { /* ignore */ }
  [...el.editorToggle.querySelectorAll('button')].forEach((b) => {
    b.classList.toggle('active', b.dataset.name === name);
  });
}

function render() {
  populateFilterOptions();
  updateSummary();
  renderTasks();
  if (currentView === 'report') renderReportView();
}

function openModal(task = null) {
  editingTaskId = task ? task.id : null;
  el.modalTitle.textContent = task ? 'Edit Task' : 'Add Task';
  document.getElementById('taskId').value = task ? task.id : '';
  document.getElementById('taskName').value = task ? task.name : '';
  document.getElementById('taskProject').value = task ? task.project : '';
  document.getElementById('taskWeekDate').value = task ? task.weekDate : '';
  document.getElementById('taskStatus').value = task ? task.status : 'To Do';
  document.getElementById('taskPriority').value = task ? task.priority : 'Medium';
  document.getElementById('taskDueDate').value = task ? task.dueDate : '';
  document.getElementById('taskWorkDone').value = task ? task.workDone : '';
  document.getElementById('taskValidation').value = task ? task.validation : '';
  document.getElementById('taskLinks').value = task ? task.links : '';
  document.getElementById('taskNotes').value = task ? task.notes : '';
  el.modal.hidden = false;
  document.getElementById('taskName').focus();
}

function closeModal() {
  el.modal.hidden = true;
  el.form.reset();
  editingTaskId = null;
}

function openDetails(task) {
  detailsTaskId = task.id;
  el.detailsName.textContent = task.name || '(untitled task)';
  el.detailsMeta.innerHTML = [
    task.project ? escapeHtml(task.project) : '',
    task.weekDate ? escapeHtml(task.weekDate) : '',
    `<span class="badge ${statusBadgeClass(task.status)}">${escapeHtml(task.status)}</span>`,
    task.priority ? `<span class="badge ${priorityBadgeClass(task.priority)}">${escapeHtml(task.priority)}</span>` : '',
    task.dueDate ? `Due ${escapeHtml(task.dueDate)}` : '',
    task.editorTag ? `Tagged: ${escapeHtml(task.editorTag)}` : '',
  ].filter(Boolean).join(' · ');
  el.detailsWorkDone.textContent = task.workDone || '—';
  el.detailsValidation.textContent = task.validation || '—';
  el.detailsLinks.innerHTML = task.links ? renderLinks(task.links) : '—';
  el.detailsNotes.textContent = task.notes || '—';
  el.detailsModal.hidden = false;
}

function closeDetails() {
  el.detailsModal.hidden = true;
  detailsTaskId = null;
}

async function handleFormSubmit(e) {
  e.preventDefault();
  if (!currentUser) return;

  const taskData = {
    name: document.getElementById('taskName').value.trim(),
    project: document.getElementById('taskProject').value.trim(),
    weekDate: document.getElementById('taskWeekDate').value.trim(),
    status: document.getElementById('taskStatus').value,
    priority: document.getElementById('taskPriority').value,
    dueDate: document.getElementById('taskDueDate').value,
    workDone: document.getElementById('taskWorkDone').value.trim(),
    validation: document.getElementById('taskValidation').value.trim(),
    links: document.getElementById('taskLinks').value.trim(),
    notes: document.getElementById('taskNotes').value.trim(),
    // App-level attribution tag only — separate from the createdBy/updatedBy
    // audit fields below, which stay driven by the authenticated Firebase user.
    editorTag: editorName,
  };

  if (!taskData.name) return;

  clearError();
  const submitBtn = el.form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  const who = currentUser.displayName || currentUser.email || currentUser.uid;

  try {
    if (editingTaskId) {
      await updateDoc(doc(db, 'tasks', editingTaskId), {
        ...taskData,
        updatedAt: serverTimestamp(),
        updatedBy: currentUser.uid,
        updatedByName: who,
      });
    } else {
      await addDoc(tasksCollection, {
        ...taskData,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdBy: currentUser.uid,
        createdByName: who,
        updatedBy: currentUser.uid,
        updatedByName: who,
      });
    }
    closeModal();
  } catch (err) {
    console.error('Failed to save task', err);
    showError('Failed to save task: ' + err.message);
  } finally {
    submitBtn.disabled = false;
  }
}

function handleTableClick(e) {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const task = tasks.find(t => t.id === row.dataset.id);
  if (task) openDetails(task);
}

async function handleDeleteTask(id, name) {
  if (!confirm(`Delete task "${name}"? This removes it permanently, including from historical reports.`)) return;
  clearError();
  try {
    await deleteDoc(doc(db, 'tasks', id));
  } catch (err) {
    console.error('Failed to delete task', err);
    showError('Failed to delete task: ' + err.message);
  }
}

function subscribeToTasks() {
  setLoading('Loading tasks...');
  unsubscribeTasks = onSnapshot(
    tasksQuery,
    (snapshot) => {
      tasks = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setLoading(null);
      clearError();
      render();
    },
    (err) => {
      console.error('Failed to load tasks', err);
      setLoading(null);
      showError('Failed to load tasks: ' + err.message);
    }
  );
}

el.signInBtn.addEventListener('click', async () => {
  clearError();
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    console.error('Sign-in failed', err);
    showError('Sign-in failed: ' + err.message);
  }
});

async function handleSignOut() {
  clearError();
  try {
    await signOut(auth);
  } catch (err) {
    console.error('Sign-out failed', err);
    showError('Sign-out failed: ' + err.message);
  }
}

el.signOutBtn.addEventListener('click', handleSignOut);
el.accessDeniedSignOutBtn.addEventListener('click', handleSignOut);

el.addTaskBtn.addEventListener('click', () => openModal());
el.cancelBtn.addEventListener('click', closeModal);
el.modal.addEventListener('click', (e) => {
  if (e.target === el.modal) closeModal();
});
el.form.addEventListener('submit', handleFormSubmit);
el.tableBody.addEventListener('click', handleTableClick);

el.detailsCloseX.addEventListener('click', closeDetails);
el.detailsCloseBtn.addEventListener('click', closeDetails);
el.detailsModal.addEventListener('click', (e) => {
  if (e.target === el.detailsModal) closeDetails();
});
el.detailsEditBtn.addEventListener('click', () => {
  const task = tasks.find(t => t.id === detailsTaskId);
  closeDetails();
  if (task) openModal(task);
});
el.detailsDeleteBtn.addEventListener('click', () => {
  const task = tasks.find(t => t.id === detailsTaskId);
  if (!task) return;
  closeDetails();
  handleDeleteTask(task.id, task.name);
});

el.filterStatus.addEventListener('change', render);
el.filterProject.addEventListener('change', render);
el.filterPriority.addEventListener('change', render);
el.filterWeek.addEventListener('change', render);
el.clearFiltersBtn.addEventListener('click', () => {
  el.filterStatus.value = '';
  el.filterProject.value = '';
  el.filterPriority.value = '';
  el.filterWeek.value = '';
  render();
});

el.viewTableBtn.addEventListener('click', () => setView('table'));
el.viewReportBtn.addEventListener('click', () => setView('report'));
el.copyReportBtn.addEventListener('click', handleCopyReport);
el.printReportBtn.addEventListener('click', () => window.print());

el.editorToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-name]');
  if (btn) setEditor(btn.dataset.name);
});
setEditor(editorName);

onAuthStateChanged(auth, (user) => {
  currentUser = user;

  if (unsubscribeTasks) {
    unsubscribeTasks();
    unsubscribeTasks = null;
  }

  setLoading(null);
  clearError();

  if (user) {
    el.authScreen.hidden = true;
    el.userInfo.hidden = false;
    el.userLabel.textContent = user.displayName || user.email || 'Signed in';

    if (!isApproved(user)) {
      el.appMain.hidden = true;
      el.addTaskBtn.hidden = true;
      el.editorSelect.hidden = true;
      el.accessDeniedMessage.textContent =
        `Signed in as ${user.email}. This dashboard is limited to approved accounts — ask an admin to add your email if you believe this is a mistake.`;
      el.accessDeniedScreen.hidden = false;
      tasks = [];
      return;
    }

    el.accessDeniedScreen.hidden = true;
    el.appMain.hidden = false;
    el.editorSelect.hidden = false;
    setView('table');
    subscribeToTasks();
  } else {
    closeModal();
    closeDetails();
    el.authScreen.hidden = false;
    el.accessDeniedScreen.hidden = true;
    el.appMain.hidden = true;
    el.addTaskBtn.hidden = true;
    el.editorSelect.hidden = true;
    el.userInfo.hidden = true;
    tasks = [];
    render();
  }
});

// ============================================================================
// ONE-TIME MANUAL MIGRATION — Weekly Ops Dashboard Artifact -> Firestore
// ============================================================================
// Defines window.__migrateArtifactTasks(): a manually-invoked, one-time
// import of the Artifact's 34 historical tasks into the production `tasks`
// collection. Nothing in this block runs on page load, on sign-in, or as a
// result of any UI interaction — it only becomes CALLABLE. It must be
// invoked explicitly, once, from the browser DevTools console on the live
// production page by a signed-in, approved user:
//
//   await window.__migrateArtifactTasks()
//
// No argument is needed — the verified 34-task source dataset is embedded
// below (ARTIFACT_TASKS_SOURCE), read directly from the Weekly Ops
// Dashboard Artifact's own database on 2026-09-16.
//
// Remove this entire block (including ARTIFACT_TASKS_SOURCE) in a
// follow-up cleanup commit once the one-time import has been performed and
// verified.

const ARTIFACT_TASKS_SOURCE = [
  {"id":"report-task-01","createdAt":"2025-07-31T22:13:20Z","dueDate":"","links":"Zap: ClickFunnels → Zoom → GHL — https://zapier.com/editor/368466387/published?conversationId=64798912-3e34-4542-b019-410078cde355","name":"Webinar Registration Tag Automation","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-07-31T22:13:20Z","validation":"Registration flow and personalized Zoom link mapping tested successfully.","weekDate":"JULY 29 - AUG 05","workDone":"Built the ClickFunnels → Zoom → GHL registration flow with personalized Zoom links and webinar custom fields, and updated tags for the Aug 4 webinar."},
  {"id":"report-task-02","createdAt":"2025-07-31T23:13:20Z","dueDate":"","links":"GHL: Email Reminder Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/6b574857-060c-4945-81bc-532b2effedee","name":"GHL Email Reminder Workflow","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-07-31T23:13:20Z","validation":"Wait actions and dynamic event start time confirmed working.","weekDate":"JULY 29 - AUG 05","workDone":"Rebuilt the email reminder workflow to use dynamic webinar fields instead of hardcoded dates, retargeted to the Aug 4 registrant tag."},
  {"id":"report-task-03","createdAt":"2025-08-01T00:13:20Z","dueDate":"","links":"Zap: SimpleTexting SMS Reminder — https://zapier.com/editor/369317197/published, GHL: SMS Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/0bf67647-4c3b-41b5-a158-2e79d868e73b","name":"SMS Reminder Automation","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T00:13:20Z","validation":"All three SMS reminders confirmed delivered with correct Zoom link formatting.","weekDate":"JULY 29 - AUG 05","workDone":"Built the GHL/SimpleTexting SMS routing workflow with phone validation and finalized SMS #1-#3."},
  {"id":"report-task-04","createdAt":"2025-08-01T01:13:20Z","dueDate":"","links":"","name":"Pipeline Updates","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T01:13:20Z","validation":"","weekDate":"JULY 29 - AUG 05","workDone":"Rolled webinar automations from the Evergreen – July to Evergreen – August pipeline."},
  {"id":"report-task-05","createdAt":"2025-08-01T02:13:20Z","dueDate":"","links":"","name":"Research & Improvements","notes":"Report's own status: \"In Progress/Pending.\" Also planning an automation to auto-move Pending opportunities monthly.","priority":"","project":"Bling Empire","status":"In Progress","updatedAt":"2025-08-01T02:13:20Z","validation":"","weekDate":"JULY 29 - AUG 05","workDone":"Investigating timezone personalization for webinar reminders; confirmed Zoom's API doesn't return registrant timezone, exploring alternatives."},
  {"id":"report-task-06","createdAt":"2025-08-01T03:13:20Z","dueDate":"","links":"Zap: Martin Calendly → GHL — https://zapier.com/editor/373927509/published","name":"Martin Calendly + GHL Booking Fix","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T03:13:20Z","validation":"Test booking confirmed working and synced to the GHL Calendar.","weekDate":"AUG 05 - AUG 12","workDone":"Fixed a missing Zoom link on Martin's shared Calendly event and connected his Calendly to his dedicated GHL user."},
  {"id":"report-task-07","createdAt":"2025-08-01T04:13:20Z","dueDate":"","links":"Zap: Pending Pipeline Monthly Migration Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/bcf0454d-0777-4c49-bd92-f61d042d2df2","name":"Monthly Pending Pipeline Migration","notes":"Existing Pending backlog from before activation needs a one-time manual move.","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T04:13:20Z","validation":"Tested successfully via TJ TESTING; opportunity moved and stayed Pending.","weekDate":"AUG 05 - AUG 12","workDone":"Built a native GHL workflow to auto-roll Pending opportunities into next month's Evergreen pipeline."},
  {"id":"report-task-08","createdAt":"2025-08-01T05:13:20Z","dueDate":"","links":"Zap: CLICKFUNNELS -> Timezone Personalization — https://zapier.com/editor/00000000-0000-c000-8000-000375494247/published, GHL: SMS Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/0bf67647-4c3b-41b5-a158-2e79d868e73b, ClickFunnels: Webinar Main — https://scotthosteamworkspace.myclickfunnels.com/account/funnels/jDaznV/workflow_steps/kGzwqZ/workflow_steps_show_page_steps/zWQbyQ/edit_page/RKRqnM, ClickFunnels: Webinar Page Duplicated (later for starters) — https://scotthosteamworkspace.myclickfunnels.com/account/funnels/NEWxBB/workflow_steps/znrYdV/workflow_steps_show_page_steps/DdqLLq/edit_page/KWNaWD","name":"Webinar SMS Timezone Personalization","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T05:13:20Z","validation":"Full flow tested; Renzo received a correctly localized SMS (Pacific → Chicago time).","weekDate":"AUG 05 - AUG 12","workDone":"Added timezone-detection JS to Webinar Thank You pages and updated SMS reminders to use each registrant's local time with DST handling."},
  {"id":"report-task-09","createdAt":"2025-08-01T06:13:20Z","dueDate":"","links":"Interface: Cohort Sales Dashboard — https://airtable.com/appUqJ226wIo93lij/pagEyWX327k2dmmEt/edit","name":"Cohort Sales Dashboard Updates","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T06:13:20Z","validation":"Counters confirmed displaying correctly.","weekDate":"AUG 05 - AUG 12","workDone":"Added separate Not Sold reason counters (Finances, Not Right Fit, Not Right Timing) to the Cohort Sales Dashboard."},
  {"id":"report-task-10","createdAt":"2025-08-01T07:13:20Z","dueDate":"","links":"Interface: Closer Dashboard — https://airtable.com/appUqJ226wIo93lij/pagrNIzZsWFs4x1Jx/edit","name":"Closer Dashboard","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T07:13:20Z","validation":"","weekDate":"AUG 05 - AUG 12","workDone":"Built a new Closer Dashboard in Airtable for Julian + Martin with core KPIs, payment plan breakdown, and Cohort/Month/Rep filtering."},
  {"id":"report-task-11","createdAt":"2025-08-01T08:13:20Z","dueDate":"","links":"","name":"Client Onboarding Email Check","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T08:13:20Z","validation":"Field confirmed updating to YES after a normal 1-2 minute GHL delay.","weekDate":"AUG 12 - AUG 19","workDone":"Investigated a delayed \"Onboarding Email Sent?\" field update and confirmed the email was actually sent and delivered."},
  {"id":"report-task-12","createdAt":"2025-08-01T09:13:20Z","dueDate":"","links":"","name":"Starter + Scaler Discord Welcome Messages","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T09:13:20Z","validation":"Confirmed the correct program is highlighted in each message.","weekDate":"AUG 12 - AUG 19","workDone":"Reworded Starter and Scaler Discord welcome messages so each program is clearly highlighted."},
  {"id":"report-task-13","createdAt":"2025-08-01T10:13:20Z","dueDate":"","links":"","name":"Webinar Setup Coordination","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T10:13:20Z","validation":"Resolved — final schedule confirmed as Aug 25, 4:00 PM Pacific.","weekDate":"AUG 12 - AUG 19","workDone":"Caught a date/time mismatch between the Webby setup template (Aug 19) and Zoom schedule (Aug 20); followed up with Ricardo to confirm the correct date."},
  {"id":"report-task-14","createdAt":"2025-08-01T11:13:20Z","dueDate":"","links":"Zap: Typeform → GHL — https://zapier.com/editor/357882599/published","name":"Typeform → GHL Zap Cleanup","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T11:13:20Z","validation":"Confirmed contact creation/update still works and the old Airtable step is gone.","weekDate":"AUG 12 - AUG 19","workDone":"Removed an obsolete Airtable step (pointing to a deleted table) from the Typeform → GHL Zap, simplifying it to a direct Typeform → GHL flow."},
  {"id":"report-task-15","createdAt":"2025-08-01T12:13:20Z","dueDate":"","links":"Zap: Typeform → Discord Alerts Zap — https://zapier.com/editor/365412464/run/01405a6e-1770-a028-8244-8dc8a1806264","name":"Typeform → Discord Alerts Fix","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T12:13:20Z","validation":"Retested a previously failing submission; all 3 messages delivered successfully.","weekDate":"AUG 12 - AUG 19","workDone":"Split long Typeform application alerts into 3 labeled Discord messages to stay under Discord's 2,000-character limit."},
  {"id":"report-task-16","createdAt":"2025-08-01T13:13:20Z","dueDate":"","links":"","name":"Zapier Error Notification Loop","notes":"Manual Zap ON/OFF changes aren't covered by Zapier's standard alerts.","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T13:13:20Z","validation":"Confirmed error/auto-pause notifications and forwarding are working.","weekDate":"AUG 12 - AUG 19","workDone":"Set key BE Zaps to high-priority error alerts and set up Gmail filtering to forward Dev-account Zapier alerts to TJ."},
  {"id":"report-task-17","createdAt":"2025-08-01T14:13:20Z","dueDate":"","links":"","name":"Last 7-Day Error Recovery","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T14:13:20Z","validation":"Confirmed replayed runs completed and all Discord message parts delivered.","weekDate":"AUG 12 - AUG 19","workDone":"Reviewed the past week's Zap errors (4 runs, all Typeform → Discord) and replayed only the missing ones."},
  {"id":"report-task-18","createdAt":"2025-08-01T15:13:20Z","dueDate":"","links":"GHL: Email Reminder Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/6b574857-060c-4945-81bc-532b2effedee, GHL: SMS Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/0bf67647-4c3b-41b5-a158-2e79d868e73b, Zap: SimpleTexting SMS Reminder — https://zapier.com/editor/369317197/published, ClickFunnels: Starter / Scaler Thank You Pages — https://scotthosteamworkspace.myclickfunnels.com/account/funnels/jDaznV/workflow_steps/kGzwqZ/workflow_steps_show_page_steps/zWQbyQ/edit_page/RKRqnM","name":"Webby | August 25, 2026","notes":"Final check still open: confirm timezone JS on production pages, verify SMS mappings, and run an end-to-end test before publishing.","priority":"","project":"Bling Empire","status":"In Progress","updatedAt":"2025-08-01T15:13:20Z","validation":"","weekDate":"AUG 12 - AUG 19","workDone":"Finalized Aug 25 Webby scheduling — updated Zoom link, GHL tags/fields, email/SMS reminder timing, and ClickFunnels timezone JS."},
  {"id":"report-task-19","createdAt":"2025-08-01T16:13:20Z","dueDate":"","links":"GHL: Martin Booking → Notify Julian Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/d1eaf2e5-44ac-4351-8c0b-d750605eb609","name":"Martin Booking → Notify Julian","notes":"Monitor future Martin bookings to confirm ongoing coverage.","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T16:13:20Z","validation":"Tested successfully; notification received and both booking sources covered.","weekDate":"AUG 19 - AUG 26","workDone":"Built a GHL workflow notifying Julian of Martin's bookings from both booking sources, including client/date/time/call link."},
  {"id":"report-task-20","createdAt":"2025-08-01T17:13:20Z","dueDate":"","links":"Zap: SimpleTexting SMS Reminder — https://zapier.com/editor/369317197/published, GHL: SMS Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/0bf67647-4c3b-41b5-a158-2e79d868e73b","name":"Webby SMS Testing & Troubleshooting","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T17:13:20Z","validation":"Confirmed registration and timezone personalization processed correctly; SMS delivery for the two flagged cases stayed inconclusive.","weekDate":"AUG 19 - AUG 26","workDone":"Tested Aug 25 Webby SMS delivery and investigated SimpleTexting errors for two registrants (Renzo, Ronda) without touching production queues."},
  {"id":"report-task-21","createdAt":"2025-08-01T18:13:20Z","dueDate":"","links":"GHL: WEBBY: No-Show Email — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/931459d2-4a2a-49c7-a66b-1b1ce5372ec4","name":"Webby | No-Show Email Sequence","notes":"Complete end-to-end testing before processing real no-show contacts.","priority":"","project":"Bling Empire","status":"In Progress","updatedAt":"2025-08-01T18:13:20Z","validation":"Workflow published; full end-to-end test still pending.","weekDate":"AUG 19 - AUG 26","workDone":"Built and published Ronda's 5-email No-Show sequence in GHL with personalization, replay links, and UTM tracking."},
  {"id":"report-task-22","createdAt":"2025-08-01T19:13:20Z","dueDate":"","links":"Webby Setup Request Template — https://docs.google.com/document/d/161L-0clzcepa-zBfzfJ9qSNSE5MDU05rnn8hTSmtFvw/edit?tab=t.d2k9ybc9gpgl","name":"Webby Setup Process Improvement","notes":"Apply the new QA process to the next Webby and refine as needed.","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T19:13:20Z","validation":"QA tab added and ready for use on future Webbies.","weekDate":"AUG 19 - AUG 26","workDone":"Added a FINAL OPS QA tab to the Webby Setup Template, standardizing pre-launch checks (timing, links, tags, SMS/email, JS, testing)."},
  {"id":"report-task-23","createdAt":"2025-08-01T20:13:20Z","dueDate":"","links":"","name":"Cohort Sales Dashboard + Client Updates","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T20:13:20Z","validation":"","weekDate":"AUG 26 - SEP 2","workDone":"Fixed Nick Wang's $6.5K PIH close in Airtable and categorized Pietro under Scalers; standardized client categorization going forward."},
  {"id":"report-task-24","createdAt":"2025-08-01T21:13:20Z","dueDate":"","links":"GHL: Email Reminder Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/6b574857-060c-4945-81bc-532b2effedee, GHL: SMS Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/0bf67647-4c3b-41b5-a158-2e79d868e73b, Zap: SimpleTexting SMS Reminder — https://zapier.com/editor/369317197/published, ClickFunnels: Starter / Scaler Thank You Pages — https://scotthosteamworkspace.myclickfunnels.com/account/funnels/jDaznV/workflow_steps/kGzwqZ/workflow_steps_show_page_steps/zWQbyQ/edit_page/RKRqnM","name":"Webby End-to-End Automation Testing","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T21:13:20Z","validation":"Confirmed the full flow worked — registration, timely email and SMS reminders, and correct routing end-to-end.","weekDate":"AUG 26 - SEP 2","workDone":"Ran a full Sept 1 test Webby across Zoom, GHL, ClickFunnels, Zapier, and SimpleTexting using Renzo as the test registrant."},
  {"id":"report-task-25","createdAt":"2025-08-01T22:13:20Z","dueDate":"","links":"","name":"Starter + Scaler Discord Onboarding Update","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-01T22:13:20Z","validation":"Tested in a live client channel; dashboard link confirmed working as Step #4.","weekDate":"AUG 26 - SEP 2","workDone":"Updated Discord onboarding messages to link directly to the new Client Dashboard."},
  {"id":"report-task-26","createdAt":"2025-08-01T23:13:20Z","dueDate":"","links":"","name":"SimpleTexting SMS Delivery Investigation","notes":"Report's own status: \"Completed / In Progress.\" Keep monitoring SMS delivery on upcoming Webbies.","priority":"","project":"Bling Empire","status":"In Progress","updatedAt":"2025-08-01T23:13:20Z","validation":"Latest controlled test confirmed successful delivery; support attributed prior gaps to possible phone-side spam filtering.","weekDate":"AUG 26 - SEP 2","workDone":"Continued investigating inconsistent SMS delivery with SimpleTexting support."},
  {"id":"report-task-27","createdAt":"2025-08-02T00:13:20Z","dueDate":"","links":"GHL: Retargeting - Not Sold Leads Pipeline — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/opportunities, GHL: Retargeting Lead Follow-Up Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/e6ab04c0-59b5-479e-8837-4c3692e1a83d, GHL: Retargeting Call Booking Workflow — https://app.gohighlevel.com/v2/location/9ctaPVNeFajI7ZdgAyGs/automation/workflow/2d7f6a4f-8034-4e7c-8e29-3890db0e7cbe","name":"Retargeting - Not Sold Leads","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-02T00:13:20Z","validation":"Tested pipeline movement, follow-up task creation, and booking logic successfully.","weekDate":"SEP 2 - SEP 9","workDone":"Built a new Retargeting pipeline and workflows in GHL to follow up with not-sold leads and auto-advance them on booking."},
  {"id":"report-task-28","createdAt":"2025-08-02T01:13:20Z","dueDate":"","links":"","name":"GHL Booking Notification QA","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-02T01:13:20Z","validation":"Confirmed all booking fields now populate correctly.","weekDate":"SEP 2 - SEP 9","workDone":"Retested the Martin Booking → Notify Julian workflow after a report of blank booking details."},
  {"id":"report-task-29","createdAt":"2025-08-02T02:13:20Z","dueDate":"","links":"","name":"Sept 15 Webby Setup / Handoff","notes":"Ongoing: supporting Renzo with the existing automation setup during handoff.","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-02T02:13:20Z","validation":"","weekDate":"SEP 2 - SEP 9","workDone":"Set up the Sept 15 Webby requirements and transitioned primary Webby/marketing ownership to Renzo."},
  {"id":"report-task-30","createdAt":"2025-08-02T03:13:20Z","dueDate":"","links":"","name":"New Client Ops / Sales Dashboard QA","notes":"Next: take over the Fitness Biz tracker, confirm the source of truth for client dates, and prepare the Sept-Nov program end-date list via PR review with Renzo.","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-02T03:13:20Z","validation":"Confirmed both clients are reflected correctly in the dashboard.","weekDate":"SEP 2 - SEP 9","workDone":"Onboarded new clients Peter Nguyen and Peter Modi and checked their records against the Cohort Sales Dashboard."},
  {"id":"report-task-31","createdAt":"2025-08-02T04:13:20Z","dueDate":"","links":"","name":"Martin / Calendly Booking Issue","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-02T04:13:20Z","validation":"Confirmed the booking notification is working correctly and verified Katherine Hong's booking was correctly captured in GHL.","weekDate":"SEP 9 - SEP 16","workDone":"Investigated why Dawon Isaac Lee's booking appeared in Martin's Calendly but was missing from the GHL Calendar. Found an unselected duplicate Bling Empire Strategy Call (Calendly) event type, enabled it, and updated the notification workflow trigger."},
  {"id":"report-task-32","createdAt":"2025-08-02T05:13:20Z","dueDate":"","links":"","name":"Webby Opportunity Naming Issue","notes":"Per TJ, automation-related issues will be raised in the group chat moving forward so the correct owner can handle them.","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-02T05:13:20Z","validation":"Issue ownership was confirmed with Renzo. No changes were made on our side to avoid conflicting with the existing automation.","weekDate":"SEP 9 - SEP 16","workDone":"Investigated Webby opportunities displaying the webinar date/ID instead of the contact name and confirmed with Renzo that the issue is connected to his Webby automation."},
  {"id":"report-task-33","createdAt":"2025-08-02T06:13:20Z","dueDate":"","links":"","name":"Peter Zhang Offboarding","notes":"","priority":"","project":"Bling Empire","status":"Completed","updatedAt":"2025-08-02T06:13:20Z","validation":"Offboarding completed.","weekDate":"SEP 9 - SEP 16","workDone":"Successfully off-boarded Peter Zhang."},
  {"id":"report-task-34","createdAt":"2025-08-02T07:13:20Z","dueDate":"","links":"GitHub PR #389 — https://github.com/bling-dev-team/bling-empire/pull/389","name":"Resign Tracker","notes":"Waiting on Renzo's feedback: whether the Resign Tracker should write programStart and programEnd; how migrations bli232-234 should be applied (currently the main blocker); and whether contracts marked \"DO NOT INCLUDE IN RESIGN\" should still count toward \"ending next month.\" Production rendering and Playwright validation remain pending until migrations are applied and the feature is deployed.","priority":"","project":"Bling Empire","status":"In Progress","updatedAt":"2025-08-02T07:13:20Z","validation":"Code-level guards and typecheck are green. Production rendering and Playwright validation have not yet been completed.","weekDate":"SEP 9 - SEP 16","workDone":"Built the Resign Tracker with /resigns and /resigns/commissions in the team app, based on Contract rather than Client. Guards and typecheck are passing."}
];

const MIGRATION_ID_PREFIX = 'artifact-';
const MIGRATION_EXPECTED_TOTAL = 34;
const MIGRATION_EXPECTED_COMPLETED = 29;
const MIGRATION_EXPECTED_IN_PROGRESS = 5;
const MIGRATION_EXPECTED_TODO_PENDING = 0;

function validateMigrationSource(sourceTasks) {
  if (!Array.isArray(sourceTasks) || sourceTasks.length !== MIGRATION_EXPECTED_TOTAL) {
    throw new Error(`Expected exactly ${MIGRATION_EXPECTED_TOTAL} source tasks, got ${sourceTasks && sourceTasks.length}.`);
  }
  const counts = { Completed: 0, 'In Progress': 0, 'To Do': 0, Pending: 0 };
  for (const t of sourceTasks) {
    if (!t.id || !t.name || !(t.status in counts)) {
      throw new Error(`Malformed source task: ${JSON.stringify(t).slice(0, 200)}`);
    }
    counts[t.status]++;
  }
  const todoPending = counts['To Do'] + counts['Pending'];
  if (
    counts.Completed !== MIGRATION_EXPECTED_COMPLETED ||
    counts['In Progress'] !== MIGRATION_EXPECTED_IN_PROGRESS ||
    todoPending !== MIGRATION_EXPECTED_TODO_PENDING
  ) {
    throw new Error(
      `Aggregate mismatch: Completed=${counts.Completed} InProgress=${counts['In Progress']} ` +
      `ToDo/Pending=${todoPending}. Refusing to proceed.`
    );
  }
  const idSet = new Set(sourceTasks.map((t) => t.id));
  if (idSet.size !== MIGRATION_EXPECTED_TOTAL) {
    throw new Error('Migration aborted: source task ids are not unique.');
  }
  return counts;
}

function migrationDownloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function migrateArtifactTasks() {
  const sourceTasks = ARTIFACT_TASKS_SOURCE;

  // --- Preflight: auth + approval. Mirrors the Firestore Rules'
  // isAllowedUser() check client-side as defense in depth — the write would
  // be rejected server-side regardless, but this fails fast with a clear
  // message and avoids an unnecessary round trip. ---
  if (!currentUser) throw new Error('Migration aborted: no signed-in Firebase user.');
  if (!currentUser.emailVerified) throw new Error('Migration aborted: signed-in user email is not verified.');
  if (!isApproved(currentUser)) throw new Error('Migration aborted: signed-in user is not in APPROVED_EMAILS.');

  // --- Preflight: source dataset shape ---
  const counts = validateMigrationSource(sourceTasks);
  console.log(`[migration] Source validated: ${sourceTasks.length} tasks ` +
    `(${counts.Completed} Completed / ${counts['In Progress']} In Progress / ` +
    `${counts['To Do'] + counts['Pending']} To Do-Pending).`);

  // --- Read the full existing collection first. This single read serves
  // two purposes: (a) the pre-migration backup/export, and (b) the
  // duplicate-import check (scanning for any artifact-* IDs already
  // present) — no separate reads needed for either. ---
  const existingSnap = await getDocs(tasksCollection);
  const existingDocs = existingSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
  console.log(`[migration] Read ${existingDocs.length} existing document(s) from tasks/.`);

  const alreadyMigrated = existingDocs.filter((d) => d.id.startsWith(MIGRATION_ID_PREFIX));
  if (alreadyMigrated.length > 0) {
    console.error('[migration] ABORTING — artifact-* documents already exist:', alreadyMigrated.map((d) => d.id));
    throw new Error(
      `Migration aborted: ${alreadyMigrated.length} artifact-* document(s) already present ` +
      `(${alreadyMigrated.map((d) => d.id).join(', ')}). No writes performed.`
    );
  }

  if (existingDocs.length !== 1) {
    console.warn('[migration] Existing collection is not exactly 1 document as expected:', existingDocs.map((d) => d.id));
    throw new Error(
      `Migration aborted: expected exactly 1 existing document, found ${existingDocs.length}. ` +
      `Review before proceeding. No writes performed.`
    );
  }

  // --- Backup: log in full and offer a downloadable JSON export. Firestore
  // Timestamp values are converted to ISO strings so the export is plain,
  // portable JSON. ---
  const backup = existingDocs.map(({ id, data }) => ({
    id,
    data: Object.fromEntries(Object.entries(data).map(([k, v]) =>
      [k, v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v]
    )),
  }));
  const backupFilename = `tasks-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  console.log('[migration] Pre-migration backup:', JSON.stringify(backup, null, 2));
  migrationDownloadJson(backupFilename, backup);
  console.log(`[migration] Backup downloaded as "${backupFilename}" and logged above. Verify it before continuing.`);

  // --- Build the 34 write payloads. ---
  //
  // Historical createdAt/updatedAt are preserved from the Artifact source
  // (converted to real Firestore Timestamps — required both for
  // formatTimestamp()'s ts.toDate() call and for orderBy('createdAt','desc')
  // to sort correctly, since Firestore orders by type before value).
  //
  // AUDIT-FIELD RULE: these are historical imported records. The Artifact
  // source carries no trustworthy original Firebase UID/name for who did
  // this work, and the Wheng/TJ "Editing as" selector is a UI attribution
  // tag, not a Firebase identity — so neither is used to populate
  // createdBy/createdByName/updatedBy/updatedByName. Those fields are
  // deliberately OMITTED on migrated documents rather than fabricated
  // (production's rowTitle()/openDetails() already render correctly when
  // they're absent, same as any task predating this field). Provenance for
  // the import itself — who ran it, when — is instead recorded in clearly
  // separate fields (migratedBy/migratedByName/migratedFromArtifact/
  // sourceArtifactTaskId/migratedAt), using the real signed-in user's
  // identity honestly: as the importer, never as the historical author.
  const migratedByUid = currentUser.uid;
  const migratedByName = currentUser.displayName || currentUser.email || currentUser.uid;
  const migratedAt = serverTimestamp();
  const payloads = sourceTasks.map((t) => {
    const { id: sourceId, createdAt, updatedAt, ...rest } = t;
    return {
      docId: MIGRATION_ID_PREFIX + sourceId,
      data: {
        ...rest,
        createdAt: Timestamp.fromDate(new Date(createdAt)),
        updatedAt: Timestamp.fromDate(new Date(updatedAt)),
        migratedFromArtifact: true,
        sourceArtifactTaskId: sourceId,
        migratedBy: migratedByUid,
        migratedByName,
        migratedAt,
      },
    };
  });

  const idSet = new Set(payloads.map((p) => p.docId));
  if (idSet.size !== MIGRATION_EXPECTED_TOTAL) {
    throw new Error('Migration aborted: computed document IDs are not unique.');
  }

  console.log(`[migration] About to write ${payloads.length} documents in one atomic batch:`, payloads.map((p) => p.docId));

  // --- Atomic batched write. All 34 succeed together or none do. ---
  const batch = writeBatch(db);
  for (const { docId, data } of payloads) {
    batch.set(doc(db, 'tasks', docId), data);
  }
  await batch.commit();

  console.log(`[migration] DONE. Wrote ${payloads.length} documents. Existing document ` +
    `(${existingDocs[0].id}) was not touched. No createdBy/createdByName/updatedBy/updatedByName ` +
    `were set on the imported documents.`);
  return { written: payloads.length, existingBefore: existingDocs.length, backupFilename };
}

window.__migrateArtifactTasks = migrateArtifactTasks;
