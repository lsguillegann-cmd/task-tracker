#!/usr/bin/env node
// scripts/migrate-artifact-tasks.mjs
//
// One-time, local, administrative migration: writes the 34 Weekly Ops
// Dashboard Artifact tasks into the production `tasks` Firestore
// collection. This script is NOT part of the deployed application — it is
// excluded from the Cloudflare static asset bundle via .assetsignore
// ("scripts"), and its input/output data is excluded from git via
// .gitignore ("/scripts/migration-input/", "/scripts/backups/"). It must
// be run manually, locally, by a human with a Firebase Admin service
// account for the task-tracker-8bc67 project.
//
// This uses the Firebase ADMIN SDK, not the client Web SDK — Admin
// credentials bypass Firestore Security Rules by design, which is the
// correct model for a genuine administrative migration (as opposed to
// weakening the production rules, or performing the write through an
// authenticated end-user browser session).
//
// Usage:
//   node scripts/migrate-artifact-tasks.mjs --dry-run
//     Loads and validates the source dataset, computes every write
//     payload, and prints a full summary. Makes NO network connection —
//     safe to run anywhere, anytime, with no credentials at all.
//
//   node scripts/migrate-artifact-tasks.mjs --execute --service-account=/path/to/key.json
//     NOT RUN BY THIS SCRIPT AUTOMATICALLY. Requires a local Firebase
//     Admin service-account key file (never committed — keep it outside
//     the repo or in an already-gitignored location). Verifies the target
//     Firebase project, reads and backs up the entire existing `tasks`
//     collection, confirms it matches the expected pre-migration state,
//     re-checks for any already-migrated documents, then performs one
//     atomic batched write of the 34 new documents. Existing documents are
//     never read for the purpose of mutation, updated, or deleted.
//
// Source dataset location: this script reads task JSON files from
// scripts/migration-input/tasks/*.json (one file per task, filename =
// document id, e.g. report-task-01.json) or from the directory named by
// the ARTIFACT_TASKS_DIR environment variable. That directory is
// gitignored and must be populated locally before running — see the
// accompanying report for exactly what it contains.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_TASKS_DIR = process.env.ARTIFACT_TASKS_DIR || path.join(__dirname, 'migration-input', 'tasks');
const BACKUP_DIR = path.join(__dirname, 'backups');
const COLLECTION = 'tasks';
const ID_PREFIX = 'artifact-';
const EXPECTED_TOTAL = 34;
const EXPECTED_COMPLETED = 29;
const EXPECTED_IN_PROGRESS = 5;
const EXPECTED_TODO_PENDING = 0;
const EXPECTED_PROJECT_ID = 'task-tracker-8bc67'; // from firebase-config.js — sanity check only, not a secret

function loadArtifactTasks() {
  let files;
  try {
    files = readdirSync(ARTIFACT_TASKS_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    throw new Error(
      `Could not read source dataset directory "${ARTIFACT_TASKS_DIR}": ${err.message}\n` +
      `Populate it first (one JSON file per task, filename = document id) or set ARTIFACT_TASKS_DIR.`
    );
  }
  if (files.length !== EXPECTED_TOTAL) {
    throw new Error(`Expected exactly ${EXPECTED_TOTAL} source task files, found ${files.length}. Aborting.`);
  }
  return files.map((f) => {
    const sourceId = path.basename(f, '.json');
    const data = JSON.parse(readFileSync(path.join(ARTIFACT_TASKS_DIR, f), 'utf8'));
    return { sourceId, data };
  });
}

function validateAggregate(tasks) {
  const counts = { Completed: 0, 'In Progress': 0, 'To Do': 0, Pending: 0 };
  for (const { sourceId, data } of tasks) {
    const requiredFields = ['name', 'project', 'weekDate', 'status', 'priority', 'dueDate', 'workDone', 'validation', 'links', 'notes', 'createdAt', 'updatedAt'];
    for (const field of requiredFields) {
      if (!(field in data)) throw new Error(`Task ${sourceId} is missing required field "${field}". Aborting.`);
    }
    if (!(data.status in counts)) throw new Error(`Task ${sourceId} has unexpected status "${data.status}". Aborting.`);
    counts[data.status]++;
  }
  const todoPending = counts['To Do'] + counts['Pending'];
  if (
    tasks.length !== EXPECTED_TOTAL ||
    counts.Completed !== EXPECTED_COMPLETED ||
    counts['In Progress'] !== EXPECTED_IN_PROGRESS ||
    todoPending !== EXPECTED_TODO_PENDING
  ) {
    throw new Error(
      `Aggregate mismatch: total=${tasks.length} Completed=${counts.Completed} ` +
      `InProgress=${counts['In Progress']} ToDo/Pending=${todoPending}. Refusing to proceed.`
    );
  }
  return counts;
}

function computeTargetIds(tasks) {
  const ids = tasks.map(({ sourceId }) => ID_PREFIX + sourceId);
  const unique = new Set(ids);
  if (unique.size !== EXPECTED_TOTAL) {
    throw new Error('Computed deterministic document IDs are not unique. Aborting.');
  }
  return ids;
}

// Every source field is copied verbatim except createdAt/updatedAt, which
// are converted from ISO-8601 strings to real Firestore Timestamps
// (required both for app.js's formatTimestamp() — which needs
// ts.toDate() — and for orderBy('createdAt','desc') to sort correctly
// alongside existing Timestamp-typed documents; Firestore sorts by type
// before value, so mixing string- and Timestamp-typed createdAt values in
// one query would cluster them into separate blocks instead of
// interleaving chronologically).
//
// AUDIT-FIELD RULE: these are historical imported records. The Artifact
// source carries no trustworthy original Firebase UID/name for who did
// this work, so createdBy/createdByName/updatedBy/updatedByName are
// deliberately OMITTED rather than fabricated (production's
// rowTitle()/openDetails() already render correctly when absent).
// Provenance for the import itself is recorded separately via
// migratedBy/migratedByName/migratedFromArtifact/sourceArtifactTaskId/
// migratedAt, using the identity of whoever runs --execute — honestly, as
// the importer, never as the historical author.
function toFirestorePayload(sourceId, data, timestampFromIso, migratedByUid, migratedByName, migratedAtValue) {
  const { createdAt, updatedAt, ...rest } = data;
  return {
    ...rest,
    createdAt: timestampFromIso(createdAt),
    updatedAt: timestampFromIso(updatedAt),
    migratedFromArtifact: true,
    sourceArtifactTaskId: sourceId,
    migratedBy: migratedByUid,
    migratedByName,
    migratedAt: migratedAtValue,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');

  const tasks = loadArtifactTasks();
  const counts = validateAggregate(tasks);
  const targetIds = computeTargetIds(tasks);
  console.log(
    `Loaded and validated ${tasks.length} source tasks ` +
    `(${counts.Completed} Completed / ${counts['In Progress']} In Progress / ` +
    `${counts['To Do'] + counts['Pending']} To Do-Pending). All ${targetIds.length} target IDs unique.`
  );

  if (dryRun) {
    console.log('--- DRY RUN: no Firestore connection made, no reads or writes performed ---');
    const preview = tasks.map(({ sourceId, data }) => {
      const docId = ID_PREFIX + sourceId;
      const payload = toFirestorePayload(
        sourceId,
        data,
        (iso) => ({ __wouldBeFirestoreTimestamp: true, isoSource: iso }),
        '<uid of whoever runs --execute>',
        '<display name of whoever runs --execute>',
        { __wouldBeFirestoreTimestamp: true, isoSource: '<migration run time>' }
      );
      return { targetDocPath: `${COLLECTION}/${docId}`, payload };
    });
    const outPath = path.join(__dirname, 'backups', 'dry-run-output.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(preview, null, 2));
    console.log(`Dry run complete. ${preview.length} write payloads computed.`);
    console.log(`Full preview written to ${outPath} (gitignored — not committed).`);
    console.log('0 documents read from production. 0 documents written to production.');
    console.log('\nTarget document IDs:');
    console.log(targetIds.join(', '));
    console.log('\nSample (first payload):');
    console.log(JSON.stringify(preview[0], null, 2));
    return;
  }

  // --execute path.
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
  const serviceAccountPath =
    args.find((a) => a.startsWith('--service-account='))?.split('=')[1] ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!serviceAccountPath) {
    throw new Error('No service account provided. Refusing to run against production without explicit credentials.');
  }
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));

  // --- Verify the target project before touching anything. ---
  if (serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
    throw new Error(
      `Service account is for project "${serviceAccount.project_id}", expected "${EXPECTED_PROJECT_ID}". Refusing to proceed.`
    );
  }
  console.log(`Authenticated to Firebase project: ${serviceAccount.project_id}`);

  const app = initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore(app);
  const migratedByUid = `admin-script:${serviceAccount.client_email || 'unknown'}`;
  const migratedByName = `Admin migration script (${serviceAccount.client_email || 'unknown'})`;

  // --- Read and back up the ENTIRE existing collection before any write. ---
  const existingSnap = await db.collection(COLLECTION).get();
  const existingDocs = existingSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
  mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `tasks-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(backupPath, JSON.stringify(existingDocs, null, 2));
  console.log(`Backed up ${existingDocs.length} existing document(s) to ${backupPath} (gitignored — not committed).`);

  // --- Confirm expected current production state before mutating anything. ---
  const alreadyMigrated = existingDocs.filter((d) => d.id.startsWith(ID_PREFIX));
  if (alreadyMigrated.length > 0) {
    throw new Error(
      `Refusing to proceed: ${alreadyMigrated.length} artifact-* document(s) already exist ` +
      `(${alreadyMigrated.map((d) => d.id).join(', ')}). No writes performed.`
    );
  }
  if (existingDocs.length !== 1) {
    throw new Error(
      `Refusing to proceed: expected exactly 1 existing document, found ${existingDocs.length} ` +
      `(${existingDocs.map((d) => d.id).join(', ')}). Review before proceeding. No writes performed.`
    );
  }
  console.log(`Confirmed expected pre-migration state: exactly 1 existing document (${existingDocs[0].id}).`);

  // --- Idempotent, additive, atomic batched write. Re-running this script
  // targets the exact same 34 deterministic doc IDs every time — it can
  // only overwrite its own prior migration output, never create
  // duplicates, and never touches any other document in the collection. ---
  const migratedAtValue = Timestamp.now();
  const batch = db.batch();
  for (const { sourceId, data } of tasks) {
    const ref = db.collection(COLLECTION).doc(ID_PREFIX + sourceId);
    batch.set(ref, toFirestorePayload(
      sourceId, data, (iso) => Timestamp.fromDate(new Date(iso)),
      migratedByUid, migratedByName, migratedAtValue
    ));
  }
  await batch.commit();
  console.log(
    `Migrated ${tasks.length} tasks into ${COLLECTION}/ using deterministic IDs ` +
    `(${ID_PREFIX}report-task-01..34). Existing document (${existingDocs[0].id}) untouched. ` +
    `No createdBy/createdByName/updatedBy/updatedByName were set on the imported documents.`
  );
}

main().catch((err) => {
  console.error('Migration aborted:', err.message);
  process.exit(1);
});
