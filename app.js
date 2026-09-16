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

const el = {
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
      el.accessDeniedMessage.textContent =
        `Signed in as ${user.email}. This dashboard is limited to approved accounts — ask an admin to add your email if you believe this is a mistake.`;
      el.accessDeniedScreen.hidden = false;
      tasks = [];
      return;
    }

    el.accessDeniedScreen.hidden = true;
    el.appMain.hidden = false;
    setView('table');
    subscribeToTasks();
  } else {
    closeModal();
    closeDetails();
    el.authScreen.hidden = false;
    el.accessDeniedScreen.hidden = true;
    el.appMain.hidden = true;
    el.addTaskBtn.hidden = true;
    el.userInfo.hidden = true;
    tasks = [];
    render();
  }
});
