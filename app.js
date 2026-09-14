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

let tasks = [];
let editingTaskId = null;
let currentUser = null;
let unsubscribeTasks = null;

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
  countTotal: document.getElementById('countTotal'),
  countTodo: document.getElementById('countTodo'),
  countInProgress: document.getElementById('countInProgress'),
  countCompleted: document.getElementById('countCompleted'),
  authScreen: document.getElementById('authScreen'),
  loadingScreen: document.getElementById('loadingScreen'),
  appMain: document.getElementById('appMain'),
  signInBtn: document.getElementById('signInBtn'),
  signOutBtn: document.getElementById('signOutBtn'),
  userInfo: document.getElementById('userInfo'),
  userLabel: document.getElementById('userLabel'),
  errorBanner: document.getElementById('errorBanner'),
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

function populateProjectFilter() {
  const currentValue = el.filterProject.value;
  const projects = [...new Set(tasks.map(t => t.project).filter(Boolean))].sort();
  el.filterProject.innerHTML = '<option value="">All</option>' +
    projects.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  if (projects.includes(currentValue)) {
    el.filterProject.value = currentValue;
  }
}

function updateSummary() {
  el.countTotal.textContent = tasks.length;
  el.countTodo.textContent = tasks.filter(t => t.status === 'To Do').length;
  el.countInProgress.textContent = tasks.filter(t => t.status === 'In Progress').length;
  el.countCompleted.textContent = tasks.filter(t => t.status === 'Completed').length;
}

function getFilteredTasks() {
  const statusFilter = el.filterStatus.value;
  const projectFilter = el.filterProject.value;
  return tasks.filter(t => {
    if (statusFilter && t.status !== statusFilter) return false;
    if (projectFilter && t.project !== projectFilter) return false;
    return true;
  });
}

function renderTasks() {
  const filtered = getFilteredTasks();
  el.emptyState.hidden = filtered.length > 0;
  el.tableBody.innerHTML = filtered.map(t => `
    <tr data-id="${t.id}">
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.project)}</td>
      <td>${escapeHtml(t.weekDate)}</td>
      <td><span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status)}</span></td>
      <td><span class="badge ${priorityBadgeClass(t.priority)}">${escapeHtml(t.priority)}</span></td>
      <td>${escapeHtml(t.dueDate)}</td>
      <td>${escapeHtml(t.workDone)}</td>
      <td>${escapeHtml(t.validation)}</td>
      <td>${renderLinks(t.links)}</td>
      <td>${escapeHtml(t.notes)}</td>
      <td class="row-actions">
        <button class="btn btn-secondary btn-edit" data-id="${t.id}">Edit</button>
        <button class="btn btn-danger btn-delete" data-id="${t.id}">Delete</button>
      </td>
    </tr>
  `).join('');
}

function render() {
  populateProjectFilter();
  updateSummary();
  renderTasks();
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

async function handleTableClick(e) {
  const editBtn = e.target.closest('.btn-edit');
  const deleteBtn = e.target.closest('.btn-delete');

  if (editBtn) {
    const task = tasks.find(t => t.id === editBtn.dataset.id);
    if (task) openModal(task);
  }

  if (deleteBtn) {
    const task = tasks.find(t => t.id === deleteBtn.dataset.id);
    if (task && confirm(`Delete task "${task.name}"?`)) {
      clearError();
      try {
        await deleteDoc(doc(db, 'tasks', deleteBtn.dataset.id));
      } catch (err) {
        console.error('Failed to delete task', err);
        showError('Failed to delete task: ' + err.message);
      }
    }
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

el.signOutBtn.addEventListener('click', async () => {
  clearError();
  try {
    await signOut(auth);
  } catch (err) {
    console.error('Sign-out failed', err);
    showError('Sign-out failed: ' + err.message);
  }
});

el.addTaskBtn.addEventListener('click', () => openModal());
el.cancelBtn.addEventListener('click', closeModal);
el.modal.addEventListener('click', (e) => {
  if (e.target === el.modal) closeModal();
});
el.form.addEventListener('submit', handleFormSubmit);
el.tableBody.addEventListener('click', handleTableClick);
el.filterStatus.addEventListener('change', renderTasks);
el.filterProject.addEventListener('change', renderTasks);

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
    el.appMain.hidden = false;
    el.addTaskBtn.hidden = false;
    el.userInfo.hidden = false;
    el.userLabel.textContent = user.displayName || user.email || 'Signed in';
    subscribeToTasks();
  } else {
    closeModal();
    el.authScreen.hidden = false;
    el.appMain.hidden = true;
    el.addTaskBtn.hidden = true;
    el.userInfo.hidden = true;
    tasks = [];
    render();
  }
});
